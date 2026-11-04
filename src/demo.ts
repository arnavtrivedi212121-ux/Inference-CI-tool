import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startMockServer } from './mock/server.js';
import type { MockOptions } from './mock/settings.js';
import { configSchema } from './config.js';

const cases = [
  { name: 'healthy', baseline: {}, candidate: {}, expected: 'PASS' },
  { name: 'slow-first-token', baseline: {}, candidate: { firstTokenDelayMs: 350 }, expected: 'FAIL' },
  { name: 'slow-generation', baseline: {}, candidate: { tokenDelayMs: 70 }, expected: 'FAIL' },
  { name: 'errors', baseline: {}, candidate: { errorRate: 0.5 }, expected: 'FAIL' },
  { name: 'disconnect', baseline: {}, candidate: { disconnectAfterTokens: 3 }, expected: 'FAIL' },
  { name: 'timeout', baseline: {}, candidate: { stall: true }, expected: 'FAIL' },
  { name: 'missing-usage', baseline: {}, candidate: { omitUsage: true }, expected: 'INCONCLUSIVE' },
  { name: 'short-output', baseline: {}, candidate: { outputTokens: 2 }, expected: 'INCONCLUSIVE' },
  { name: 'broken-baseline', baseline: { errorRate: 1 }, candidate: {}, expected: 'ERROR' },
] satisfies { name: string; baseline: MockOptions; candidate: MockOptions; expected: string }[];

function invoke(entry: string, args: string[], signal: AbortSignal) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal,
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Demo comparison exceeded 90 seconds')); }, 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function runDemo(entry: string, outputDirectory: string, trials: number, all: boolean, signal: AbortSignal, aaEvaluations = 1) {
  if (!Number.isInteger(trials) || trials < 3 || trials > 10) throw new Error('Demo trials must be an integer from 3 to 10');
  if (!Number.isInteger(aaEvaluations) || aaEvaluations < 1 || aaEvaluations > 100) throw new Error('A/A evaluations must be an integer from 1 to 100');
  const root = resolve(outputDirectory); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'demo-'));
  const workload = join(directory, 'workload.json');
  await writeFile(workload, JSON.stringify({ version: 1, requests: Array.from({ length: 5 }, (_, i) => ({
    id: `demo-${i}`, messages: [{ role: 'user', content: `Explain inference performance example ${i}.` }], generation: { temperature: 0, max_tokens: 6 },
  })) }));
  const selected = [...Array.from({ length: aaEvaluations }, () => cases[0]!), ...(all ? cases.slice(1) : cases.slice(1, 4))];
  const results = [];
  let preparation: { calibrationId: string; lock: string; comparison: string; verified: boolean } | undefined;
  for (const [index, scenario] of selected.entries()) {
    signal.throwIfAborted();
    const defaults = { port: 0, seed: 42, outputTokens: 6, firstTokenDelayMs: 50, tokenDelayMs: 1 };
    const baseline = await startMockServer({ ...defaults, ...scenario.baseline });
    let candidate: Awaited<ReturnType<typeof startMockServer>> | undefined;
    try {
      candidate = await startMockServer({ ...defaults, ...scenario.candidate });
      const metadata = { runtimeVersion: 'mock-v2', modelRevision: 'mock-v2', tokenizerId: 'mock-v2', hardware: 'synthetic CPU fixture' };
      const config = configSchema.parse({ version: 2,
        baseline: { url: baseline.endpoint, model: 'mock-model', deployment: { id: 'baseline', ...metadata } },
        candidate: { url: candidate.endpoint, model: 'mock-model', deployment: { id: 'candidate', ...metadata } }, workload,
        run: { concurrency: 128, repetitions: 20, warmupRequests: 0, timeoutMs: 800, seed: 42, trials,
          cooldownMs: 0, arrivalIntervalMs: 3, maxArrivalLagMs: 1000 },
        thresholds: { ttftP95MaxIncreasePercent: 200, latencyP95MaxIncreasePercent: 150, throughputMaxDecreasePercent: 40,
          errorRateMaxIncreasePercentagePoints: 1, candidateMaxErrorRatePercent: 1 },
        baselineValidity: { maxErrorRatePercent: 1, minSuccessfulRequests: 100 }, outputDir: join(directory, `${index}-${scenario.name}`),
      });
      const configPath = join(directory, `${index}-${scenario.name}.json`); await writeFile(configPath, JSON.stringify(config, null, 2));
      const child = await invoke(entry, ['compare', '--config', configPath, '--json'], signal);
      if (child.stderr) throw new Error(`Demo ${scenario.name}: ${child.stderr}`);
      const report = JSON.parse(child.stdout);
      const saved = JSON.parse(await readFile(report.artifacts.json, 'utf8'));
      const html = await readFile(report.artifacts.html, 'utf8');
      const raw = (await readFile(report.artifacts.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const dispatched = raw.filter(record => record.failure?.kind !== 'schedule');
      const completed = raw.filter(record => record.success).length;
      const failed = dispatched.filter(record => !record.success).length;
      const accounting = report.assessment.accounting;
      const accountingAgrees = report.version === 3 && report.requestRecordVersion === 2
        && accounting?.plannedRequests === raw.length && accounting.dispatchedRequests === dispatched.length
        && accounting.completedRequests === completed && accounting.failedRequests === failed
        && accounting.missedArrivals === raw.length - dispatched.length
        && accounting.requestFailureRatePercent === (dispatched.length ? failed / dispatched.length * 100 : null)
        && report.assessment.nextActions.length > 0 && (report.comparison.verdict === 'PASS' || report.assessment.findings.length > 0);
      const expectedCode = scenario.expected === 'PASS' ? 0 : scenario.expected === 'FAIL' ? 1 : 2;
      const artifactsAgree = accountingAgrees && saved.runId === report.runId && saved.comparison.verdict === report.comparison.verdict
        && html.includes(`<title>${report.comparison.verdict} ·`) && raw.length === 200 * trials && raw.every(record => record.runId === report.runId);
      const consistentPlan = report.phases.every((phase: { baseline: { planHash: string }; candidate: { planHash: string } }) =>
        phase.baseline.planHash === report.planHash && phase.candidate.planHash === report.planHash);
      const fingerprint = (id: number) => JSON.stringify(raw.filter(record => record.trialId === id).map(record => ({
        deployment: record.deployment, id: record.id, plannedOffsetMs: record.plannedOffsetMs, success: record.success, failure: record.failure?.kind ?? null,
      })));
      const stableFailures = Array.from({ length: trials }, (_, i) => fingerprint(i + 1)).every(value => value === fingerprint(1));
      const success = child.code === expectedCode && report.comparison.verdict === scenario.expected && artifactsAgree && consistentPlan && stableFailures;
      results.push({ scenario: scenario.name, expected: scenario.expected, verdict: report.comparison.verdict, exitCode: child.code,
        success, report: report.artifacts.html, planHash: report.planHash, workloadHash: report.workloadHash,
        mockSettings: { baseline: baseline.settings, candidate: candidate.settings } });
      console.log(`${scenario.name}: ${report.comparison.verdict}, exit ${child.code} · ${trials} fixed-plan trial pairs · ${success ? 'verified' : 'UNEXPECTED'}`);
      if (index === 0) {
        const preparationConfig = structuredClone(config);
        preparationConfig.run = { ...preparationConfig.run, repetitions: 40, concurrency: 256 };
        preparationConfig.baselineValidity.minSuccessfulRequests = 200;
        preparationConfig.candidate = { url: 'http://127.0.0.1:1/v1/chat/completions', model: 'unused', apiKeyEnv: 'INFERENCEGATE_DEMO_UNUSED_KEY' };
        const preparationPath = join(directory, 'preparation-config.json'), planPath = join(directory, 'calibration-plan.json');
        await writeFile(preparationPath, JSON.stringify(preparationConfig));
        await writeFile(planPath, JSON.stringify({ version: 1, arrivalIntervalsMs: [3, 6], generatorHoldMs: 400,
          baselineLimits: { ttftP95MaxMs: 200, latencyP95MaxMs: 300 } }));
        const prepared = await invoke(entry, ['calibrate', '--config', preparationPath, '--plan', planPath, '--json'], signal);
        if (prepared.code !== 0) throw new Error(`Compiled calibration failed: ${prepared.stdout || prepared.stderr}`);
        const proof = JSON.parse(prepared.stdout);
        preparationConfig.candidate = config.candidate; preparationConfig.run.arrivalIntervalMs = 999;
        await writeFile(preparationPath, JSON.stringify(preparationConfig));
        const locked = await invoke(entry, ['compare', '--config', preparationPath, '--lock', proof.artifacts.lock, '--json'], signal);
        if (locked.code !== 0) throw new Error(`Compiled locked comparison failed: ${locked.stdout || locked.stderr}`);
        const lockedReport = JSON.parse(locked.stdout), lock = JSON.parse(await readFile(proof.artifacts.lock, 'utf8'));
        const verified = proof.status === 'READY' && lockedReport.comparison.verdict === 'PASS'
          && lockedReport.calibration.calibrationId === proof.preparationId && lockedReport.planHash === lock.planHash
          && lockedReport.configuration.run.arrivalIntervalMs === proof.selectedIntervalMs;
        preparation = { calibrationId: proof.preparationId, lock: proof.artifacts.lock, comparison: lockedReport.artifacts.html, verified };
        if (!verified) throw new Error('Compiled calibration/lock evidence did not agree');
        console.log('Baseline-only calibration and locked comparison: verified');
      }
    } finally { await Promise.all([baseline.close(), candidate?.close()]); }
  }
  const aa = results.filter(result => result.scenario === 'healthy');
  const falseBlocks = aa.filter(result => result.verdict !== 'PASS').length;
  const summary = { version: 2, success: results.every(result => result.success) && preparation?.verified === true, preparation, trialPairsPerComparison: trials, seed: 42,
    falseBlockStudy: { evaluations: aa.length, falseBlocks, observedRate: falseBlocks / aa.length,
      inconclusive: aa.filter(result => result.verdict === 'INCONCLUSIVE').length, errors: aa.filter(result => result.verdict === 'ERROR').length,
      failures: aa.filter(result => result.verdict === 'FAIL').length, note: 'Observed synthetic A/A rate, not an estimate of production false-block probability.' }, results };
  const path = join(directory, 'verification.json'); await writeFile(path, JSON.stringify(summary, null, 2));
  console.log(`Evidence: ${path}; A/A false blocks ${falseBlocks}/${aa.length}`);
  if (!summary.success) throw new Error('Demo expectations failed; inspect the saved verification evidence');
  return summary;
}
