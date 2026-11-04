import { loadBenchmarkConfig } from '../src/config.js';
import type { BenchmarkRun, PhaseResult } from '../src/benchmark/runner.js';
import type { FailureKind } from '../src/benchmark/client.js';
export async function testConfig() {
  const { config } = await loadBenchmarkConfig('examples/inferencegate.json');
  config.run = { ...config.run, trials: 3, cooldownMs: 0, arrivalIntervalMs: 3, maxArrivalLagMs: 1000, concurrency: 128, warmupRequests: 0 };
  return config;
}
export function phase(ttft = 100, durationMs = 1000): PhaseResult {
  return { durationMs, planHash: 'test-plan', warmupFailures: 0, peakConcurrency: 4,
    records: Array.from({ length: 100 }, (_, i) => ({ id: `request-${i}`, workloadId: 'one', success: true,
      completed: true, finishReason: 'stop', ttftMs: ttft, latencyMs: 300, completionTokens: 10, failure: null,
      plannedOffsetMs: i * 3, dispatchOffsetMs: i * 3, arrivalLagMs: 0 })) };
}
export function runWith(candidate = phase(), baseline = phase()): BenchmarkRun {
  return { startedAt: '2026-11-02T12:00:00.000Z', planHash: 'test-plan', workloadHash: 'a'.repeat(64),
    trials: [1, 2, 3].map(id => ({ id, order: id % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
      baseline: structuredClone(baseline), candidate: structuredClone(candidate) })) };
}
export function failRecord(record: PhaseResult['records'][number], kind: FailureKind = 'http', message = 'HTTP 503') {
  Object.assign(record, { success: false, completed: false, completionTokens: null, finishReason: null, ttftMs: null,
    failure: { kind, message }, ...(kind === 'schedule' ? { dispatchOffsetMs: null, latencyMs: 0 } : {}) });
}
