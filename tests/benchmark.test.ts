import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBenchmarkConfig, workloadSchema } from '../src/config.js';
import { measureRequest, sseData } from '../src/benchmark/client.js';
import { mapConcurrent, replayPlan, runBenchmark } from '../src/benchmark/runner.js';
import { startMockServer, type MockServer } from '../src/mock/server.js';
import type { MockOptions } from '../src/mock/settings.js';
import { testConfig } from './fixtures.js';

const servers: MockServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function mock(options: MockOptions = {}) {
  const server = await startMockServer({ port: 0, outputTokens: 3, firstTokenDelayMs: 5, tokenDelayMs: 3, ...options });
  servers.push(server);
  return server;
}
const workload = workloadSchema.parse({ version: 1, requests: [
  { id: 'café', messages: [{ role: 'user', content: 'Hello' }] },
  { id: 'second', messages: [{ role: 'user', content: 'Goodbye' }] },
] });
const request = workload.requests[0]!;

describe('stream framing and request measurements', () => {
  it('handles split UTF-8, all line endings, comments, multiple data lines and multiple events', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\ndata: café\r\ndata: next\r\n\r\ndata: two\r\rdata: three\n\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const result: string[] = [];
    for await (const event of sseData(stream)) result.push(event);
    expect(result).toEqual(['café\nnext', 'two', 'three']);
  });

  it.each(['data: unfinished', 'data: no blank line\n', 'data: '+ 'a'.repeat(1_048_577)])('rejects incomplete or oversized events (%#)', async text => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    await expect((async () => { for await (const _ of sseData(stream)) { /* consume */ } })()).rejects.toThrow();
  });

  it('ignores early role events, measures content and counts reported tokens', async () => {
    const server = await mock({ firstTokenDelayMs: 100, tokenDelayMs: 25 });
    const record = await measureRequest({ url: server.endpoint, model: 'mock-model' }, request, 'test', 2000);
    expect(record.success).toBe(true);
    expect(record.ttftMs).toBeGreaterThanOrEqual(80);
    expect(record.latencyMs - record.ttftMs!).toBeGreaterThanOrEqual(35);
    expect(record.completionTokens).toBe(3);
  });

  it.each([
    [{ errorRate: 1 }, 'http'],
    [{ stall: true }, 'timeout'],
    [{ disconnectAfterTokens: 2 }, 'network'],
  ] as const)('records failed requests without retrying (%j)', async (options, kind) => {
    const server = await mock(options);
    const result = await measureRequest({ url: server.endpoint, model: 'mock-model' }, request, 'test', 'stall' in options ? 100 : 2000);
    expect(result.success).toBe(false);
    expect(result.failure?.kind).toBe(kind);
    expect(result.completionTokens).toBeNull();
  });

  it('keeps missing usage unavailable and supports explicit cancellation', async () => {
    const server = await mock({ omitUsage: true });
    const result = await measureRequest({ url: server.endpoint, model: 'mock-model' }, request, 'test', 2000);
    expect(result.success).toBe(true);
    expect(result.completionTokens).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await measureRequest({ url: server.endpoint, model: 'mock-model' }, request, 'test', 2000, undefined, controller.signal);
    expect(cancelled.failure?.kind).toBe('cancelled');
  });

  it('cleans up lifecycle phases in alternating order and exposes boundary snapshots', async () => {
    const server = await mock(); const config = await testConfig(); config.baseline.url = server.endpoint; config.candidate.url = server.endpoint;
    config.run = { ...config.run, repetitions: 1, arrivalIntervalMs: 20 };
    const calls: string[] = [];
    const result = await runBenchmark(config, workload, undefined, {
      async beforePhase(target, trial) { calls.push(`start:${trial}:${target}`); return { mode: 'test-only' }; },
      async afterPhase(target, trial) { calls.push(`stop:${trial}:${target}`); },
    });
    expect(calls.slice(0, 8)).toEqual(['start:1:baseline', 'stop:1:baseline', 'start:1:candidate', 'stop:1:candidate',
      'start:2:candidate', 'stop:2:candidate', 'start:2:baseline', 'stop:2:baseline']);
    expect(result.trials[0]!.baseline.environment).toEqual({ mode: 'test-only' });
  });

  it('cleans up a lifecycle phase when startup fails and stops before the next phase', async () => {
    const config = await testConfig();
    const calls: string[] = [];
    await expect(runBenchmark(config, workload, undefined, {
      async beforePhase(target) { calls.push(`start:${target}`); throw new Error('Readiness failed'); },
      async afterPhase(target) { calls.push(`stop:${target}`); },
    })).rejects.toThrow('Readiness failed');
    expect(calls).toEqual(['start:baseline', 'stop:baseline']);
  });

  it.each([
    'data: {bad}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[]}\n\n',
    'data: {"choices":[],"usage":{"completion_tokens":-1}}\n\n',
  ])('rejects malformed/incomplete provider streams (%#)', async payload => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No address');
      const record = await measureRequest({ url: `http://127.0.0.1:${address.port}`, model: 'mock-model' }, request, 'test', 2000);
      expect(record.failure?.kind).toBe('protocol');
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
});

describe('controlled workload replay', () => {
  it('bounds in-flight operations and records each item once in dispatch order', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const result = await mapConcurrent([0, 1, 2, 3, 4, 5], 2, async item => {
      active++; peak = Math.max(peak, active); seen.push(item);
      await delay(item % 2 ? 2 : 10);
      active--;
      return item * 2;
    });
    expect(peak).toBe(2);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('generates reproducible, unique ASCII IDs including for Unicode workload IDs', () => {
    const plan = replayPlan(workload, 10, 42);
    expect(replayPlan(workload, 10, 42)).toEqual(plan);
    expect(replayPlan(workload, 10, 43)).not.toEqual(plan);
    expect(new Set(plan.map(item => item.id)).size).toBe(20);
    expect(plan.every(item => /^[\x20-\x7e]+$/.test(item.id))).toBe(true);
  });

  it('replays identical plans and excludes warmup samples', async () => {
    const baseline = await mock(); const candidate = await mock();
    const { config } = await loadBenchmarkConfig('examples/inferencegate.json');
    config.baseline.url = baseline.endpoint; config.candidate.url = candidate.endpoint;
    config.run = { ...config.run, repetitions: 3, concurrency: 2, warmupRequests: 3, trials: 3, arrivalIntervalMs: 40, maxArrivalLagMs: 1000, cooldownMs: 0 };
    const result = await runBenchmark(config, workload);
    expect(result.trials).toHaveLength(3);
    expect(result.trials.map(trial => trial.order)).toEqual([['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate']]);
    for (const trial of result.trials) {
      expect(trial.baseline.records).toHaveLength(6);
      expect(trial.candidate.records.map(record => record.id)).toEqual(trial.baseline.records.map(record => record.id));
      expect(trial.baseline.records.every(record => record.success && record.id.startsWith('measured:'))).toBe(true);
      expect(trial.candidate.records.every(record => record.success)).toBe(true);
      expect(trial.baseline.planHash).toBe(result.planHash);
    }
    expect(result.trials[0]!.baseline.records.map(record => record.plannedOffsetMs)).toEqual(result.trials[2]!.candidate.records.map(record => record.plannedOffsetMs));
    expect(result.workloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails before traffic when an explicitly named credential is absent', async () => {
    const { config } = await loadBenchmarkConfig('examples/inferencegate.json');
    config.candidate.apiKeyEnv = 'INFERENCEGATE_TEST_MISSING_KEY';
    delete process.env.INFERENCEGATE_TEST_MISSING_KEY;
    await expect(runBenchmark(config, workload)).rejects.toThrow('missing or empty');
  });

  it('records scheduler saturation instead of silently queuing a different workload', async () => {
    const baseline = await mock({ firstTokenDelayMs: 100 });
    const config = await testConfig(); config.baseline.url = baseline.endpoint; config.candidate.url = baseline.endpoint;
    config.run = { ...config.run, concurrency: 1, repetitions: 2, arrivalIntervalMs: 1 };
    const result = await runBenchmark(config, workload);
    expect(result.trials[0]!.baseline.peakConcurrency).toBe(1);
    expect(result.trials[0]!.baseline.records.some(record => record.failure?.kind === 'schedule' && record.dispatchOffsetMs === null)).toBe(true);
  });
});
