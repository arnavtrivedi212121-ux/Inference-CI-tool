import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { configSchema, parseInput, readJson, redactEndpoint, type BenchmarkConfig, type Workload } from '../config.js';
import { startMockServer } from '../mock/server.js';
import { publishArtifacts } from '../reporting/artifacts.js';
import { hash, measurePhase, replayPlan, resolveCredential, type PhaseResult } from './runner.js';
import { summarize } from './compare.js';

const milliseconds = z.number().int().positive().max(60_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const calibrationPlanSchema = z.strictObject({
  version: z.literal(1),
  arrivalIntervalsMs: z.array(milliseconds).min(1).max(6).refine(values => values.every((value, i) => i === 0 || value > values[i - 1]!), 'Intervals must be unique and ordered fastest to slowest'),
  generatorHoldMs: z.number().int().positive().max(2_147_483_646),
  baselineLimits: z.strictObject({ ttftP95MaxMs: z.number().positive().finite(), latencyP95MaxMs: z.number().positive().finite() }),
}).refine(plan => plan.baselineLimits.ttftP95MaxMs <= plan.baselineLimits.latencyP95MaxMs && plan.baselineLimits.latencyP95MaxMs <= plan.generatorHoldMs,
  'Baseline latency limits must fit inside the declared generator response envelope');
export type CalibrationPlan = z.infer<typeof calibrationPlanSchema>;
type PhaseEvidence = { trialId: number; summary: ReturnType<typeof summarize>; planHash: string };
type Probe = { arrivalIntervalMs: number; accepted: boolean; reasons: string[]; phases: PhaseEvidence[] };
export interface CalibrationEvidence {
  calibrationId: string; lockHash: string; planHash: string; arrivalIntervalMs: number;
  generatorHoldMs: number; concurrency: number; timeoutMs: number;
  baselineLimits: CalibrationPlan['baselineLimits'];
}

/** The lock binds all serving/decision settings except the candidate and selected arrival interval. */
function binding(config: BenchmarkConfig, workload: Workload, interval: number) {
  return hash({ baseline: config.baseline, run: { ...config.run, arrivalIntervalMs: interval }, thresholds: config.thresholds,
    baselineValidity: config.baselineValidity, comparability: config.comparability, workloadHash: hash(workload) });
}

function concurrencyBudget(config: BenchmarkConfig, workload: Workload, interval: number) {
  // Budget the arrivals in one timeout plus the allowed dispatch-lag window, including its boundary.
  return Math.min(workload.requests.length * config.run.repetitions, Math.floor((config.run.timeoutMs + config.run.maxArrivalLagMs) / interval) + 1);
}

function qualification(phases: PhaseEvidence[], config: BenchmarkConfig, plan: CalibrationPlan, generator: boolean) {
  const reasons = new Set<string>();
  if (phases.length !== config.run.trials) reasons.add('The planned trial count did not complete');
  for (const { trialId, summary: s } of phases) {
    if (!s.valid) reasons.add(`Trial ${trialId}: invalid measurements`);
    if (s.warmupFailures) reasons.add(`Trial ${trialId}: warmup failed`);
    if (s.missedArrivals) reasons.add(`Trial ${trialId}: ${s.missedArrivals} arrivals were not dispatched`);
    if (s.failedRequests && (generator || s.requestFailureRatePercent! > config.baselineValidity.maxErrorRatePercent)) reasons.add(`Trial ${trialId}: ${s.failedRequests} dispatched requests failed beyond the allowed policy`);
    if (s.completedRequests < Math.max(200, config.baselineValidity.minSuccessfulRequests) || generator && s.completedRequests !== s.plannedRequests) reasons.add(`Trial ${trialId}: the plan did not produce the required successful completions`);
    if (s.missingUsage) reasons.add(`Trial ${trialId}: output usage is missing`);
    if (!generator && (s.ttftMs?.p95 == null || s.ttftMs.p95 > plan.baselineLimits.ttftP95MaxMs)) reasons.add(`Trial ${trialId}: baseline p95 TTFT exceeds the predeclared limit`);
    if (!generator && (s.latencyMs?.p95 == null || s.latencyMs.p95 > plan.baselineLimits.latencyP95MaxMs)) reasons.add(`Trial ${trialId}: baseline p95 total latency exceeds the predeclared limit`);
    if (!generator && (s.latencyMs?.max == null || s.latencyMs.max > plan.generatorHoldMs)) reasons.add(`Trial ${trialId}: a baseline response exceeded the validated response envelope`);
  }
  return [...reasons];
}

export async function prepareBenchmark(config: BenchmarkConfig, workload: Workload, planInput: CalibrationPlan, kind: 'generator' | 'baseline', outputDir: string, signal?: AbortSignal) {
  const plan = parseInput(calibrationPlanSchema, planInput, 'Calibration plan');
  const id = randomUUID(), startedAt = new Date().toISOString();
  const measuredRequests = workload.requests.length * config.run.repetitions;
  if (measuredRequests < Math.max(200, config.baselineValidity.minSuccessfulRequests) || config.baselineValidity.minSuccessfulRequests < 200) throw new Error('Preparation requires at least 200 planned and minimum successful requests per phase');
  if (plan.generatorHoldMs >= config.run.timeoutMs) throw new Error('Generator hold time must be below the request timeout');
  if (measuredRequests > 100_000 || measuredRequests * plan.arrivalIntervalsMs.at(-1)! > 86_400_000) throw new Error('Preparation exceeds the request-count or 24-hour phase bound');
  const outputTokens = workload.requests.reduce((max, request) => Math.max(max, request.generation.max_tokens), 0);
  if (outputTokens > 100_000) throw new Error('The mock generator probe supports at most 100,000 output events per request');
  const fastest = plan.arrivalIntervalsMs[0]!;
  const requiredConcurrency = concurrencyBudget(config, workload, fastest);
  const generator: Probe = { arrivalIntervalMs: fastest, accepted: false, reasons: [], phases: [] };
  const probes: Probe[] = [];
  const measurements: string[] = [];
  let status: 'READY' | 'INCONCLUSIVE' | 'ERROR' = 'INCONCLUSIVE';
  let error: string | null = null;
  let selectedIntervalMs: number | null = null;
  let baselineKey: string | undefined;
  const runPhases = async (probeConfig: BenchmarkConfig, probe: Probe, stage: 'generator' | 'baseline') => {
    for (let trialId = 1; trialId <= config.run.trials; trialId++) {
      signal?.throwIfAborted();
      if (trialId > 1) await delay(config.run.cooldownMs, undefined, { ...(signal ? { signal } : {}) });
      console.error(`${stage}: ${probe.arrivalIntervalMs} ms arrivals, trial ${trialId}/${config.run.trials}`);
      const phase: PhaseResult = await measurePhase(probeConfig, workload, 'baseline', stage === 'baseline' ? baselineKey : undefined, signal);
      probe.phases.push({ trialId, summary: summarize(phase), planHash: phase.planHash });
      for (const record of phase.records) measurements.push(JSON.stringify({ version: 1, preparationId: id, stage, arrivalIntervalMs: probe.arrivalIntervalMs, trialId, ...record }));
    }
    probe.reasons = qualification(probe.phases, config, plan, stage === 'generator');
    probe.accepted = probe.reasons.length === 0;
  };
  try {
    signal?.throwIfAborted();
    if (kind === 'baseline') baselineKey = resolveCredential(config.baseline); // Never resolve or contact the candidate.
    if (config.run.concurrency < requiredConcurrency) {
      generator.reasons.push(`Concurrency ${config.run.concurrency} is below the ${requiredConcurrency}-request bound for the fastest plan and configured timeout. No deployment requests were sent.`);
    } else {
      const mock = await startMockServer({ port: 0, firstTokenDelayMs: plan.generatorHoldMs, tokenDelayMs: 0, outputTokens });
      try {
        const probeConfig = { ...config, baseline: { url: mock.endpoint, model: mock.settings.model }, run: { ...config.run, arrivalIntervalMs: fastest } };
        await runPhases(probeConfig, generator, 'generator');
      } finally { await mock.close(); }
      if (generator.accepted && kind === 'generator') status = 'READY';
      if (generator.accepted && kind === 'baseline') for (const arrivalIntervalMs of plan.arrivalIntervalsMs) {
        signal?.throwIfAborted();
        await delay(config.run.cooldownMs, undefined, { ...(signal ? { signal } : {}) });
        const probe: Probe = { arrivalIntervalMs, accepted: false, reasons: [], phases: [] };
        probes.push(probe);
        await runPhases({ ...config, run: { ...config.run, arrivalIntervalMs } }, probe, 'baseline');
        if (probe.accepted) { selectedIntervalMs = arrivalIntervalMs; status = 'READY'; break; }
      }
    }
    signal?.throwIfAborted();
  } catch (caught) { status = 'ERROR'; error = signal?.aborted ? 'Preparation cancelled' : caught instanceof Error ? caught.message : String(caught); }
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const report = { version: 1, kind, preparationId: id, startedAt, finishedAt: new Date().toISOString(), status, error,
    runtime: { toolVersion: pkg.version, nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    workloadHash: hash(workload), policy: plan, run: config.run, thresholds: config.thresholds,
    baselineValidity: config.baselineValidity, comparability: config.comparability,
    baseline: kind === 'baseline' ? redactEndpoint(config.baseline) : null,
    requiredConcurrency, mockOutputEvents: outputTokens, generator, probes, selectedIntervalMs,
    limitations: 'Local mock evidence covers the declared response-delay/event envelope and fastest planned arrival rate, not arbitrary hardware conditions or payloads. Every comparison must still maintain arrival fidelity. Baseline-only calibration does not establish controlled GPU isolation or candidate release acceptance.',
    nextAction: status === 'READY' ? kind === 'baseline' ? 'Use the published lock for comparison; keep workload, baseline, run settings and thresholds fixed. Only the candidate and output location may change.' : 'Generator scheduling qualified under the declared mock conditions; serving capacity has not been measured.'
      : status === 'ERROR' ? 'Correct execution or credentials before repeating this experiment; no usable lock was published.'
        : !generator.accepted ? 'Correct generator capacity or scheduling fidelity independently of the serving deployments, then repeat. Do not infer an endpoint regression.'
          : 'No tested baseline tier qualified. Inspect all baseline evidence; any revised policy or workload is a separate experiment. Do not calibrate against the candidate.' };
  const files: Record<string, string> = { 'preparation.json': JSON.stringify(report, null, 2) + '\n', 'measurements.jsonl': measurements.join('\n') + (measurements.length ? '\n' : '') };
  if (status === 'READY' && selectedIntervalMs !== null) {
    files['lock.json'] = JSON.stringify({ version: 1, preparationId: id, reportHash: hash(report), workloadHash: hash(workload),
      planHash: hash(replayPlan(workload, config.run.repetitions, config.run.seed, selectedIntervalMs)),
      bindingHash: binding(config, workload, selectedIntervalMs), arrivalIntervalMs: selectedIntervalMs }, null, 2) + '\n';
  }
  const directory = await publishArtifacts(outputDir, `preparation-${id}`, files, status === 'ERROR' ? undefined : signal);
  if (status !== 'ERROR') signal?.throwIfAborted();
  return { ...report, artifacts: { directory, report: join(directory, 'preparation.json'), measurements: join(directory, 'measurements.jsonl'),
    lock: files['lock.json'] ? join(directory, 'lock.json') : null }, exitCode: status === 'READY' ? 0 : 2 };
}

const lockSchema = z.strictObject({ version: z.literal(1), preparationId: z.uuid(), reportHash: digest, workloadHash: digest,
  planHash: digest, bindingHash: digest, arrivalIntervalMs: milliseconds });

export async function applyCalibrationLock(path: string, config: BenchmarkConfig, workload: Workload): Promise<{ config: BenchmarkConfig; evidence: CalibrationEvidence }> {
  const lockPath = resolve(path), lock = parseInput(lockSchema, await readJson(lockPath), 'Calibration lock');
  const report = await readJson(join(dirname(lockPath), 'preparation.json'));
  const proof = z.object({ version: z.literal(1), kind: z.literal('baseline'), preparationId: z.uuid(), status: z.literal('READY'),
    selectedIntervalMs: milliseconds, policy: calibrationPlanSchema, generator: z.object({ accepted: z.literal(true) }),
    workloadHash: digest, baseline: configSchema.shape.baseline, run: configSchema.shape.run,
    thresholds: configSchema.shape.thresholds, baselineValidity: configSchema.shape.baselineValidity, comparability: configSchema.shape.comparability }).safeParse(report);
  if (!proof.success || hash(report) !== lock.reportHash || proof.data.preparationId !== lock.preparationId || proof.data.selectedIntervalMs !== lock.arrivalIntervalMs) throw new Error('Calibration evidence is incomplete, modified, or does not match its lock');
  const effective = { ...config, run: { ...config.run, arrivalIntervalMs: lock.arrivalIntervalMs } };
  if (effective.run.concurrency < concurrencyBudget(effective, workload, proof.data.policy.arrivalIntervalsMs[0]!)) throw new Error('Calibration generator concurrency budget is insufficient');
  const recorded = { ...effective, baseline: proof.data.baseline, run: proof.data.run, thresholds: proof.data.thresholds,
    baselineValidity: proof.data.baselineValidity, comparability: proof.data.comparability };
  if (proof.data.workloadHash !== lock.workloadHash || binding(recorded, workload, lock.arrivalIntervalMs)
    !== binding({ ...effective, baseline: redactEndpoint(effective.baseline) }, workload, lock.arrivalIntervalMs)) {
    throw new Error('Calibration report settings do not match the requested locked comparison');
  }
  if (hash(workload) !== lock.workloadHash || binding(effective, workload, lock.arrivalIntervalMs) !== lock.bindingHash
    || hash(replayPlan(workload, effective.run.repetitions, effective.run.seed, lock.arrivalIntervalMs)) !== lock.planHash) {
    throw new Error('Calibration lock mismatch: workload, baseline, run settings or thresholds changed. No benchmark traffic was sent.');
  }
  return { config: effective, evidence: { calibrationId: lock.preparationId, lockHash: hash(lock), planHash: lock.planHash,
    arrivalIntervalMs: lock.arrivalIntervalMs, generatorHoldMs: proof.data.policy.generatorHoldMs,
    concurrency: effective.run.concurrency, timeoutMs: effective.run.timeoutMs, baselineLimits: proof.data.policy.baselineLimits } };
}
