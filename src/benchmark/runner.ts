import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BenchmarkConfig, Workload } from '../config.js';
import { measureRequest, type RequestRecord } from './client.js';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Target = 'baseline' | 'candidate';
export interface ScheduledRecord extends RequestRecord {
  plannedOffsetMs: number; dispatchOffsetMs: number | null; arrivalLagMs: number | null;
}
export interface PhaseResult {
  records: ScheduledRecord[]; durationMs: number; planHash: string;
  warmupFailures: number; peakConcurrency: number;
  environment?: Record<string, unknown>;
}
export interface TrialResult {
  id: number; order: readonly Target[]; baseline: PhaseResult; candidate: PhaseResult;
}
export interface BenchmarkRun {
  trials: TrialResult[]; startedAt: string; workloadHash: string; planHash: string;
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await operation(items[index]!);
    }
  }));
  signal?.throwIfAborted();
  return results;
}

export function replayPlan(workload: Workload, repetitions: number, seed: number, arrivalIntervalMs = 100) {
  const plan = Array.from({ length: repetitions }, (_, repetition) => workload.requests.map(request => ({
    request, id: `measured:${encodeURIComponent(JSON.stringify([request.id, repetition]))}`,
  }))).flat();
  let state = seed >>> 0;
  for (let index = plan.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = Math.floor(state / 0x1_0000_0000 * (index + 1));
    [plan[index], plan[other]] = [plan[other]!, plan[index]!];
  }
  return plan.map((entry, index) => ({ ...entry, plannedOffsetMs: index * arrivalIntervalMs }));
}

export function resolveCredential(endpoint: BenchmarkConfig['baseline']) {
  if (!endpoint.apiKeyEnv) return undefined;
  const key = process.env[endpoint.apiKeyEnv];
  if (!key?.trim()) throw new Error(`Environment variable ${endpoint.apiKeyEnv} is missing or empty`);
  try { new Headers({ authorization: `Bearer ${key}` }); } catch { throw new Error(`Invalid credential in ${endpoint.apiKeyEnv}`); }
  return key;
}
export function resolveCredentials(config: BenchmarkConfig) {
  return [config.baseline, config.candidate].map(resolveCredential);
}

export async function measurePhase(config: BenchmarkConfig, workload: Workload, target: Target, apiKey?: string, signal?: AbortSignal): Promise<PhaseResult> {
  const plan = replayPlan(workload, config.run.repetitions, config.run.seed, config.run.arrivalIntervalMs);
  const warmup = await mapConcurrent(Array.from({ length: config.run.warmupRequests }, (_, index) => index), config.run.concurrency,
    index => measureRequest(config[target], workload.requests[index % workload.requests.length]!, `warmup:${index}`, config.run.timeoutMs, apiKey, signal), signal);
  const records = new Array<ScheduledRecord>(plan.length);
  const active = new Set<Promise<void>>();
  let peakConcurrency = 0;
  const start = performance.now();
  try {
    for (const [index, entry] of plan.entries()) {
      signal?.throwIfAborted();
      while (performance.now() - start < entry.plannedOffsetMs) {
        await delay(Math.max(1, entry.plannedOffsetMs - (performance.now() - start)), undefined, { ...(signal ? { signal } : {}) });
      }
      const dispatchOffsetMs = performance.now() - start;
      const arrivalLagMs = dispatchOffsetMs - entry.plannedOffsetMs;
      if (active.size >= config.run.concurrency || arrivalLagMs > config.run.maxArrivalLagMs) {
        records[index] = { id: entry.id, workloadId: entry.request.id, success: false, completed: false,
          finishReason: null, ttftMs: null, latencyMs: 0, completionTokens: null,
          plannedOffsetMs: entry.plannedOffsetMs, dispatchOffsetMs: null, arrivalLagMs,
          failure: { kind: 'schedule', message: active.size >= config.run.concurrency ? 'Concurrency limit prevented planned arrival' : 'Client missed planned arrival tolerance' } };
        continue;
      }
      const task = measureRequest(config[target], entry.request, entry.id, config.run.timeoutMs, apiKey, signal).then(record => {
        records[index] = { ...record, plannedOffsetMs: entry.plannedOffsetMs, dispatchOffsetMs, arrivalLagMs };
      });
      active.add(task); peakConcurrency = Math.max(peakConcurrency, active.size);
      void task.finally(() => active.delete(task));
    }
  } finally { await Promise.all(active); }
  signal?.throwIfAborted();
  return { records, durationMs: performance.now() - start, planHash: hash(plan), warmupFailures: warmup.filter(record => !record.success).length, peakConcurrency };
}

export interface PhaseLifecycle {
  beforePhase(target: Target, trial: number): Promise<Record<string, unknown>>;
  afterPhase(target: Target, trial: number): Promise<void>;
}

export async function runBenchmark(config: BenchmarkConfig, workload: Workload, signal?: AbortSignal, lifecycle?: PhaseLifecycle): Promise<BenchmarkRun> {
  const keys = resolveCredentials(config);
  const startedAt = new Date().toISOString();
  const trials: TrialResult[] = [];
  const planHash = hash(replayPlan(workload, config.run.repetitions, config.run.seed, config.run.arrivalIntervalMs));
  for (let id = 1; id <= config.run.trials; id++) {
    const order: Target[] = id % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    const phases = {} as Record<Target, PhaseResult>;
    for (const target of order) {
      signal?.throwIfAborted();
      if (id !== 1 || target !== 'baseline') await delay(config.run.cooldownMs, undefined, { ...(signal ? { signal } : {}) });
      try {
        const environment = await lifecycle?.beforePhase(target, id);
        phases[target] = await measurePhase(config, workload, target, keys[target === 'baseline' ? 0 : 1], signal);
        if (environment) phases[target].environment = environment;
      } finally { await lifecycle?.afterPhase(target, id); }
    }
    trials.push({ id, order, ...phases });
  }
  return { trials, startedAt, workloadHash: hash(workload), planHash };
}
