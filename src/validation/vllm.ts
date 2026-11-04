import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, platform, release } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBenchmarkConfig, parseInput, readJson } from '../config.js';
import { hash, runBenchmark, type Target } from '../benchmark/runner.js';
import { applyCalibrationLock, calibrationPlanSchema, prepareBenchmark } from '../benchmark/calibration.js';
import { createReport, writeReports } from '../reporting/report.js';

export const VLLM_IMAGE = 'vllm/vllm-openai:v0.32.0@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9';
export const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
export const REVISION = '7ae557604adf67be50417f59c2c2f167def9a775';
const execute = promisify(execFile);
async function command(file: string, args: string[], timeout = 30_000, signal?: AbortSignal) {
  const result = await execute(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) });
  return result.stdout.trim();
}
export function parseGpu(csv: string, processes: string) {
  const cells = csv.trim().split(',').map(cell => cell.trim());
  const numeric = cells.slice(3).map(Number);
  if (cells.length !== 7 || cells.some(cell => !cell) || numeric.some(value => !Number.isFinite(value) || value < 0)
    || processes && !processes.split(/\r?\n/).every(line => /^\d+$/.test(line.trim()))) {
    throw new Error('GPU telemetry is unavailable or unsupported; controlled validation cannot establish resource release');
  }
  return { uuid: cells[0]!, name: cells[1]!, driver: cells[2]!, memoryUsedMiB: numeric[0]!, memoryTotalMiB: numeric[1]!,
    utilizationPercent: numeric[2]!, temperatureC: numeric[3]!, computePids: processes ? processes.split(/\r?\n/).map(Number) : [], capturedAt: new Date().toISOString() };
}
type Snapshot = ReturnType<typeof parseGpu>;
export function assertReleased(idle: Snapshot, current: Snapshot) {
  if (current.uuid !== idle.uuid || current.driver !== idle.driver || current.memoryTotalMiB !== idle.memoryTotalMiB || current.computePids.length || current.memoryUsedMiB > idle.memoryUsedMiB + 128 || current.utilizationPercent > 5) {
    throw new Error('GPU is busy or memory has not returned to its idle budget; no competing process will be stopped');
  }
}
export function assertActive(idle: Snapshot, current: Snapshot, containerPids: number[]) {
  if (current.uuid !== idle.uuid || current.driver !== idle.driver || current.memoryTotalMiB !== idle.memoryTotalMiB
    || !containerPids.length || containerPids.some(pid => !Number.isInteger(pid) || pid <= 0)
    || !current.computePids.length || current.computePids.some(pid => !containerPids.includes(pid))) {
    throw new Error('GPU process ownership or device identity could not be established; controlled phase is invalid');
  }
}
export function serverArgs(name: string, gpu: string, port: number, sequences: number, shared: boolean) {
  return ['run', '--detach', '--name', name, '--label', 'inferencegate.validation=true', '--gpus', `device=${gpu}`,
    '--shm-size', '1g', '--publish', `127.0.0.1:${port}:8000`, '--volume', 'inferencegate-hf-cache:/root/.cache/huggingface',
    '--env', 'VLLM_NO_USAGE_STATS=1', VLLM_IMAGE, '--model', MODEL, '--revision', REVISION, '--tokenizer-revision', REVISION,
    '--served-model-name', 'validation-model', '--dtype', 'half', '--max-model-len', '2048', '--max-num-seqs', String(sequences),
    '--gpu-memory-utilization', shared ? '0.35' : '0.70', '--enforce-eager', '--no-enable-prefix-caching', '--generation-config', 'vllm', '--seed', '42'];
}

export interface VllmOptions { mode: 'controlled' | 'functional'; config: string; plan: string; gpu: string; candidateMaxSequences: number; aaEvaluations: number }
export async function validateVllm(options: VllmOptions, signal?: AbortSignal) {
  if (!/^\d+$/.test(options.gpu) || !Number.isInteger(options.candidateMaxSequences) || options.candidateMaxSequences < 1 || options.candidateMaxSequences > 8
    || !Number.isInteger(options.aaEvaluations) || options.aaEvaluations < 1 || options.aaEvaluations > 20) throw new Error('Invalid GPU index, sequence count (1–8), or A/A count (1–20)');
  const loaded = await loadBenchmarkConfig(options.config);
  if (loaded.measuredRequests < 200 || loaded.config.baselineValidity.minSuccessfulRequests < 200 || loaded.config.run.warmupRequests < 8) throw new Error('vLLM validation requires at least 200 measured/minimum successful requests and 8 warmup requests per phase');
  if (loaded.config.baseline.apiKeyEnv || loaded.config.candidate.apiKeyEnv) throw new Error('Local validation endpoints do not use API credentials');
  const shared = options.mode === 'functional';
  const policy = shared ? undefined : parseInput(calibrationPlanSchema, await readJson(options.plan), 'Calibration plan');
  const root = resolve(loaded.outputDir, `vllm-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const evidence: Record<string, unknown> = { version: 2, status: 'RUNNING', startedAt: new Date().toISOString(), mode: options.mode,
    runtime: { toolVersion: pkg.version, nodeVersion: process.version, platform: platform(), osRelease: release(), architecture: arch() },
    image: VLLM_IMAGE, model: MODEL, revision: REVISION, workloadHash: hash(loaded.workload),
    protocol: { aaEvaluations: options.aaEvaluations, baselineMaxSequences: 8, candidateMaxSequences: options.candidateMaxSequences, policy: policy ?? null }, evaluations: [] };
  const evaluations: { kind: string; verdict: string; artifacts: Awaited<ReturnType<typeof writeReports>> }[] = [];
  const gpuChecks: { container: string; gpu: Snapshot; containerPids?: number[] }[] = [];
  evidence.gpuChecks = gpuChecks;
  const owned = new Set<string>();
  const save = async () => {
    const aa = evaluations.filter(item => item.kind === 'A/A');
    evidence.falseBlocks = { count: aa.filter(item => item.verdict !== 'PASS').length, denominator: aa.length,
      rate: aa.length ? aa.filter(item => item.verdict !== 'PASS').length / aa.length : null,
      outcomes: Object.fromEntries(['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].map(verdict => [verdict, aa.filter(item => item.verdict === verdict).length])),
      interpretation: shared ? 'Functional-only results; not a performance false-block estimate' : 'Observed A/A non-PASS frequency, including execution errors; not a population probability or approved blocking policy' };
    await writeFile(join(root, 'validation.pending.json'), JSON.stringify({ ...evidence, evaluations }, null, 2) + '\n');
    await rename(join(root, 'validation.pending.json'), join(root, 'validation.json'));
  };
  const snapshot = async () => parseGpu(
    await command('nvidia-smi', ['-i', options.gpu, '--query-gpu=uuid,name,driver_version,memory.used,memory.total,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']),
    await command('nvidia-smi', ['-i', options.gpu, '--query-compute-apps=pid', '--format=csv,noheader,nounits']));
  const stop = async (name: string) => {
    if (!owned.has(name)) return;
    const logs = await execute('docker', ['logs', '--tail', '200', name], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }).catch(() => null);
    try { if (logs) await writeFile(join(root, `${name}.log`), logs.stdout + logs.stderr); }
    finally { await command('docker', ['rm', '--force', name], 60_000); owned.delete(name); }
  };
  try {
    signal?.throwIfAborted();
    await save();
    const idle = await snapshot();
    evidence.idle = idle;
    // Functional integration collects telemetry but makes no isolation or performance claim.
    if (!shared) {
      if (platform() !== 'linux' || /microsoft/i.test(release())) throw new Error('Controlled validation requires a dedicated native Linux NVIDIA host; Windows/WSL is functional-only. No deployment requests were sent.');
      assertReleased(idle, idle);
    }
    evidence.dockerVersion = await command('docker', ['version', '--format', '{{.Server.Version}}']);
    console.log('Pulling pinned vLLM image; the first run also downloads the pinned model.');
    await command('docker', ['pull', VLLM_IMAGE], 30 * 60_000, signal);
    signal?.throwIfAborted();
    evidence.resolvedImageId = await command('docker', ['image', 'inspect', VLLM_IMAGE, '--format', '{{.Id}}']);
    const released = async () => {
      const deadline = Date.now() + 60_000;
      while (true) {
        const current = await snapshot();
        evidence.lastReleaseSnapshot = current;
        try { assertReleased(idle, current); return current; } catch (error) { if (Date.now() >= deadline) throw error; }
        await delay(1000);
      }
    };
    const start = async (name: string, port: number, sequences: number) => {
      signal?.throwIfAborted();
      // Names are generated by this invocation; Docker refuses collisions. Never remove a pre-existing container.
      await command('docker', serverArgs(name, options.gpu, port, sequences, shared), 60_000);
      owned.add(name);
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (await command('docker', ['inspect', name, '--format', '{{.State.Running}}']) !== 'true') throw new Error(`vLLM exited before readiness: ${name}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
          const body = await response.json() as { data?: { id: string }[] };
          if (response.ok && body.data?.some(model => model.id === 'validation-model')) return;
        } catch { signal?.throwIfAborted(); }
        await delay(1000, undefined, { ...(signal ? { signal } : {}) });
      }
      throw new Error(`vLLM readiness timed out: ${name}`);
    };
    const activeSnapshot = async (name: string) => {
      const current = await snapshot();
      const check: typeof gpuChecks[number] = { container: name, gpu: current };
      gpuChecks.push(check);
      if (!shared) {
        const pids = (await command('docker', ['top', name, '-eo', 'pid'])).split(/\r?\n/).slice(1).map(pid => Number(pid.trim()));
        check.containerPids = pids;
        assertActive(idle, current, pids);
      }
      return current;
    };
    const baseConfig = structuredClone(loaded.config);
    baseConfig.workload = loaded.workloadPath; baseConfig.outputDir = root;
    for (const target of ['baseline', 'candidate'] as const) {
      baseConfig[target] = { url: `http://127.0.0.1:${target === 'candidate' && shared ? 18002 : 18001}/v1/chat/completions`, model: 'validation-model',
        deployment: { id: `${target}-seq8`, runtimeVersion: 'vLLM 0.32.0', modelRevision: REVISION,
          tokenizerId: `${MODEL}@${REVISION}`, hardware: `${idle.name}; ${idle.uuid}; driver ${idle.driver}`, imageDigest: VLLM_IMAGE.split('@')[1]! } };
    }
    let lockPath: string | undefined;
    if (policy) {
      const name = `ig-${randomUUID()}-calibration`;
      const environment: Record<string, unknown> = {};
      evidence.calibrationEnvironment = environment;
      try {
        await released(); await start(name, 18001, 8);
        environment.before = await activeSnapshot(name);
        const prepared = await prepareBenchmark(baseConfig, loaded.workload, policy, 'baseline', root, signal);
        evidence.preparation = { preparationId: prepared.preparationId, status: prepared.status, artifacts: prepared.artifacts };
        environment.after = await activeSnapshot(name);
        if (prepared.status !== 'READY') {
          evidence.status = prepared.status; evidence.finishedAt = new Date().toISOString();
          await save(); console.log(`Preparation did not qualify; no comparisons ran. Validation evidence: ${join(root, 'validation.json')}`);
          return 2;
        }
        lockPath = prepared.artifacts.lock!;
        const locked = await applyCalibrationLock(lockPath, baseConfig, loaded.workload);
        baseConfig.run = locked.config.run; evidence.calibration = locked.evidence;
      } finally {
        await stop(name); environment.released = await released(); await save();
      }
    }
    await writeFile(join(root, 'effective-config.json'), JSON.stringify(baseConfig, null, 2) + '\n');
    for (let evaluation = 0; evaluation <= options.aaEvaluations; evaluation++) {
      const aa = evaluation < options.aaEvaluations;
      const prefix = `ig-${randomUUID()}`;
      let config = structuredClone(baseConfig);
      config.candidate.deployment!.id = `candidate-seq${aa ? 8 : options.candidateMaxSequences}`;
      const locked = lockPath ? await applyCalibrationLock(lockPath, config, loaded.workload) : undefined;
      config = locked?.config ?? config;
      let environment: Record<string, unknown> = {};
      try {
        if (shared) {
          await start(`${prefix}-baseline`, 18001, 8);
          await start(`${prefix}-candidate`, 18002, aa ? 8 : options.candidateMaxSequences);
        }
        const run = await runBenchmark(config, loaded.workload, signal, {
          async beforePhase(target: Target, trial: number) {
            console.log(`${aa ? 'A/A' : 'Configuration comparison'} ${evaluation + 1}: trial ${trial} ${target}`);
            environment = {};
            if (!shared) { await released(); await start(`${prefix}-${trial}-${target}`, 18001, target === 'candidate' && !aa ? options.candidateMaxSequences : 8); }
            environment = { mode: shared ? 'functional-shared-gpu' : 'controlled-single-gpu', before: await activeSnapshot(`${prefix}-${shared ? target : `${trial}-${target}`}`),
              maxSequences: target === 'candidate' && !aa ? options.candidateMaxSequences : 8, image: VLLM_IMAGE, modelRevision: REVISION };
            return environment;
          },
          async afterPhase(target: Target, trial: number) {
            if (!shared && !owned.has(`${prefix}-${trial}-${target}`)) return;
            try { environment.after = await activeSnapshot(`${prefix}-${shared ? target : `${trial}-${target}`}`); } finally {
              if (!shared) { await stop(`${prefix}-${trial}-${target}`); environment.released = await released(); }
            }
          },
        });
        signal?.throwIfAborted();
        const report = await createReport(run, config, shared ? 'Functional integration only; two model servers share one GPU.' : 'Single resident server per phase; owned GPU processes checked at phase boundaries. Boundary telemetry does not prove uninterrupted hardware isolation.', locked?.evidence);
        const artifacts = await writeReports(report, root, run);
        evaluations.push({ kind: aa ? 'A/A' : 'configuration-change', verdict: report.comparison.verdict, artifacts });
        await save();
      } finally { for (const name of [...owned]) await stop(name); }
      if (!shared) await released();
    }
    evidence.status = 'COMPLETED'; evidence.finishedAt = new Date().toISOString();
    await save();
    console.log(`Validation evidence: ${join(root, 'validation.json')}`);
    return evaluations.some(item => item.verdict === 'ERROR' || item.verdict === 'INCONCLUSIVE') ? 2 : evaluations.some(item => item.verdict === 'FAIL') ? 1 : 0;
  } catch (error) {
    evidence.status = 'ERROR'; evidence.finishedAt = new Date().toISOString(); evidence.error = error instanceof Error ? error.message : String(error);
    await save();
    console.error(`Validation evidence: ${join(root, 'validation.json')}`);
    throw error;
  } finally {
    try { for (const name of [...owned]) await stop(name); }
    catch (error) { evidence.status = 'ERROR'; evidence.error = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`; await save(); throw error; }
  }
}
