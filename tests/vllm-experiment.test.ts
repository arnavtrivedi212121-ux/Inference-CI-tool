import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BenchmarkConfig, Workload } from '../src/config.js';

// Only GPU/Docker and individual request measurements are simulated. The actual
// calibration, lock verification, fixed-plan runner, verdicts and artifact writer execute.
const state = vi.hoisted(() => ({ platform: 'linux', kernel: 'native-test-kernel', active: new Map<string, number>(),
  launches: [] as { name: string; sequences: number }[], commands: [] as string[], peak: 0,
  failCalibration: false, foreign: false, failStartup: false, cancel: undefined as AbortController | undefined,
  candidateRequests: 0 }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: () => state.platform, release: () => state.kernel }));
vi.mock('node:child_process', async original => {
  const { promisify } = await import('node:util');
  const fake = Object.assign(vi.fn(), { [promisify.custom]: async (file: string, args: string[]) => {
    state.commands.push(`${file} ${args.join(' ')}`);
    let stdout = '';
    if (file === 'nvidia-smi') {
      stdout = args.some(arg => arg.startsWith('--query-gpu='))
        ? `GPU-fixture, Test GPU, 610.62, ${state.active.size ? 6000 : 500}, 12288, ${state.active.size ? 50 : 0}, 45`
        : [...state.active.values(), ...(state.foreign && [...state.active.keys()].some(name => !name.endsWith('-calibration')) ? [99999] : [])].join('\n');
    } else if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]!;
      state.active.set(name, 1000 + state.launches.length);
      state.launches.push({ name, sequences: Number(args[args.indexOf('--max-num-seqs') + 1]) });
      state.peak = Math.max(state.peak, state.active.size); stdout = name;
    } else if (args[0] === 'top') stdout = `PID\n${state.active.get(args[1]!)}`;
    else if (args[0] === 'rm') { if (!state.active.delete(args[2]!)) throw new Error('Attempted to remove an unowned container'); }
    else if (args[0] === 'logs') stdout = 'simulated server log';
    else if (args[0] === 'inspect') stdout = state.failStartup && !args[1]!.endsWith('-calibration') ? 'false' : 'true';
    else if (args[0] === 'image') stdout = 'sha256:' + 'a'.repeat(64);
    else if (args[0] === 'version') stdout = 'fixture-engine';
    return { stdout, stderr: '' };
  } });
  return { ...await original<typeof import('node:child_process')>(), execFile: fake };
});
vi.mock('../src/benchmark/client.js', async original => ({ ...await original<typeof import('../src/benchmark/client.js')>(),
  measureRequest: async (endpoint: BenchmarkConfig['baseline'], request: Workload['requests'][number], id: string) => {
    const candidate = endpoint.deployment?.id.startsWith('candidate');
    if (candidate) state.candidateRequests++;
    if (candidate && endpoint.deployment?.id.endsWith('seq1')) state.cancel?.abort(new Error('Test cancellation'));
    const fail = state.failCalibration && endpoint.deployment?.id.startsWith('baseline');
    return { id, workloadId: request.id, success: !fail, completed: !fail, finishReason: fail ? null : 'length',
      ttftMs: fail ? null : candidate && endpoint.deployment?.id.endsWith('seq1') ? 50 : 10,
      latencyMs: 80, completionTokens: fail ? null : 4, failure: fail ? { kind: 'http', message: 'HTTP 503' } : null };
  } }));

import { validateVllm } from '../src/validation/vllm.js';
import { testConfig } from './fixtures.js';
let directory: string, configPath: string, planPath: string;
beforeEach(async () => {
  Object.assign(state, { platform: 'linux', kernel: 'native-test-kernel', peak: 0, failCalibration: false, foreign: false, failStartup: false, cancel: undefined, candidateRequests: 0 });
  state.active.clear(); state.launches.length = 0; state.commands.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'validation-model' }] }), { status: 200 })));
  directory = await mkdtemp(join(tmpdir(), 'inferencegate-vllm-experiment-'));
  const config = await testConfig();
  config.run = { ...config.run, repetitions: 200, concurrency: 256, warmupRequests: 8, timeoutMs: 500, arrivalIntervalMs: 999 };
  config.baselineValidity.minSuccessfulRequests = 200;
  config.thresholds.throughputMaxDecreasePercent = 100; // Timing-independent verdict assertion; no throughput claim.
  config.workload = join(directory, 'workload.json'); config.outputDir = join(directory, 'evidence');
  await writeFile(config.workload, JSON.stringify({ version: 1, requests: [{ id: 'one', messages: [{ role: 'user', content: 'fixture' }], generation: { max_tokens: 4, temperature: 0 } }] }));
  configPath = join(directory, 'config.json'); planPath = join(directory, 'plan.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(planPath, JSON.stringify({ version: 1, arrivalIntervalsMs: [1, 2], generatorHoldMs: 100, baselineLimits: { ttftP95MaxMs: 20, latencyP95MaxMs: 100 } }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
const run = (aaEvaluations = 1, signal?: AbortSignal) => validateVllm({ mode: 'controlled', config: configPath, plan: planPath, gpu: '0', candidateMaxSequences: 1, aaEvaluations }, signal);
async function manifest() {
  const root = join(directory, 'evidence', (await readdir(join(directory, 'evidence')))[0]!);
  return { root, data: JSON.parse(await readFile(join(root, 'validation.json'), 'utf8')) };
}

it('uses one resident server, one baseline lock and an unchanged plan for A/A and a configuration breach', async () => {
  expect(await run(2)).toBe(1);
  const { root, data } = await manifest();
  expect(data.status).toBe('COMPLETED'); expect(data.version).toBe(2);
  expect(data.evaluations.map((e: {verdict:string}) => e.verdict)).toEqual(['PASS', 'PASS', 'FAIL']);
  expect(data.falseBlocks).toMatchObject({ count: 0, denominator: 2, rate: 0 });
  expect(data.calibration.arrivalIntervalMs).toBe(1); expect(state.peak).toBe(1); expect(state.active.size).toBe(0);
  expect(state.launches).toHaveLength(19); expect(state.launches.filter(s => s.sequences === 1)).toHaveLength(3);
  const reports = await Promise.all(data.evaluations.map((e: {artifacts:{json:string}}) => readFile(e.artifacts.json, 'utf8').then(JSON.parse)));
  expect(new Set(reports.map(r => r.planHash)).size).toBe(1);
  expect(reports.every(r => r.calibration.calibrationId === data.calibration.calibrationId && r.configuration.run.arrivalIntervalMs === 1)).toBe(true);
  expect(reports.every(r => r.configuration.baseline.deployment.id === 'baseline-seq8')).toBe(true);
  expect(reports.every(r => r.phases.every((p: {baseline:{environment:{released:{computePids:number[]}}};candidate:{environment:{released:{computePids:number[]}}}}) => !p.baseline.environment.released.computePids.length && !p.candidate.environment.released.computePids.length))).toBe(true);
  expect(JSON.parse(await readFile(join(root, 'effective-config.json'), 'utf8')).run.arrivalIntervalMs).toBe(1);
  expect(await readdir(root)).not.toContain('workload.json');
}, 20_000);

it('does not launch comparisons or a candidate when baseline calibration is inconclusive', async () => {
  state.failCalibration = true;
  expect(await run()).toBe(2);
  const { data } = await manifest();
  expect(data.status).toBe('INCONCLUSIVE'); expect(data.preparation.status).toBe('INCONCLUSIVE');
  expect(data.evaluations).toEqual([]); expect(data.falseBlocks.rate).toBeNull();
  expect(state.launches).toHaveLength(1); expect(state.candidateRequests).toBe(0); expect(state.active.size).toBe(0);
});

it.each(['foreign', 'failStartup'] as const)('rejects %s and preserves telemetry/logs while removing only owned containers', async fault => {
  state[fault] = true;
  await expect(run()).rejects.toThrow(fault === 'foreign' ? 'ownership' : 'exited before readiness');
  const { root, data } = await manifest();
  expect(data.status).toBe('ERROR'); expect(data.evaluations).toEqual([]); expect(state.active.size).toBe(0);
  expect((await readdir(root)).some(file => file.endsWith('.log'))).toBe(true);
  if (fault === 'foreign') expect(data.gpuChecks.at(-1).gpu.computePids).toContain(99999);
});

it('preserves completed A/A evidence when configuration measurement is cancelled', async () => {
  state.cancel = new AbortController();
  await expect(run(1, state.cancel.signal)).rejects.toThrow('Test cancellation');
  const { data } = await manifest();
  expect(data.status).toBe('ERROR'); expect(data.evaluations.map((e:{kind:string}) => e.kind)).toEqual(['A/A']);
  expect(data.falseBlocks).toMatchObject({ count: 0, denominator: 1 }); expect(state.active.size).toBe(0);
});

it.each([['win32', 'Windows'], ['linux', '6.18-microsoft-standard-WSL2']])('refuses %s / %s before Docker or deployment traffic', async (platform, kernel) => {
  state.platform = platform; state.kernel = kernel;
  await expect(run()).rejects.toThrow('native Linux');
  const { data } = await manifest();
  expect(data.status).toBe('ERROR'); expect(data.idle.uuid).toBe('GPU-fixture');
  expect(state.commands.every(command => command.startsWith('nvidia-smi'))).toBe(true);
  expect(state.launches).toHaveLength(0);
});
