import { expect, it } from 'vitest';
import { compare, compareTrials, distribution, summarize } from '../src/benchmark/compare.js';
import { failRecord, phase, runWith, testConfig } from './fixtures.js';
const config = await testConfig();
it('calculates nearest-rank percentiles without pooling trial p95 values', () => {
  expect(distribution([])).toBeNull();
  expect(distribution(Array.from({ length: 100 }, (_, i) => i + 1))).toMatchObject({ p50: 50, p95: 95, p99: 99 });
});
it('passes equality and fails values just above the limit', () => {
  expect(compare(phase(), phase(120), config).verdict).toBe('PASS');
  expect(compare(phase(), phase(120.001), config).verdict).toBe('FAIL');
  expect(compare(phase(0), phase(1), config).checks[0]?.limit).toBe(0);
});
it('uses both-side sample sufficiency, preserving error evidence', () => {
  const candidate = phase(); candidate.records[0]!.success = false; candidate.records[0]!.completed = false;
  candidate.records[0]!.failure = { kind: 'http', message: 'HTTP 503' }; candidate.records[0]!.completionTokens = null;
  expect(compare(phase(), candidate, config).verdict).toBe('INCONCLUSIVE');
  candidate.records[1] = structuredClone(candidate.records[0]!); candidate.records[1]!.id = 'request-1'; candidate.records[1]!.plannedOffsetMs = 3;
  expect(compare(phase(), candidate, config).verdict).toBe('FAIL');
  expect(summarize(candidate).ttftMs?.count).toBe(98);
});
it('cannot approve shorter, unfinished, missing-usage or different-tokenizer outputs', () => {
  const short = phase(); short.records.forEach(record => { record.completionTokens = 4; record.latencyMs = 150; });
  expect(compare(phase(), short, config).verdict).toBe('INCONCLUSIVE');
  const finish = phase(); finish.records[0]!.finishReason = 'length';
  expect(compare(phase(), finish, config).verdict).toBe('INCONCLUSIVE');
  const missing = phase(); missing.records[0]!.completionTokens = null;
  expect(summarize(missing).throughputTokensPerSecond).toBeNull();
  expect(compare(phase(), missing, config).verdict).toBe('INCONCLUSIVE');
  const other = structuredClone(config); other.candidate.deployment!.tokenizerId = 'different';
  expect(compare(phase(), phase(), other).verdict).toBe('INCONCLUSIVE');
  const incomplete = phase(); incomplete.records[0]!.completed = false;
  expect(compare(phase(), incomplete, config).verdict).toBe('ERROR');
});
it('blocks schedule misses, invalid baselines, and mismatched plans', () => {
  const schedule = phase(); failRecord(schedule.records[0]!, 'schedule', 'late');
  expect(compare(phase(), schedule, config).verdict).toBe('INCONCLUSIVE');
  const mismatched = phase(); mismatched.planHash = 'other';
  expect(compare(phase(), mismatched, config).verdict).toBe('ERROR');
  const duplicate = phase(); duplicate.records[0]!.id = duplicate.records[1]!.id;
  expect(compare(phase(), duplicate, config).verdict).toBe('ERROR');
  const invalid = phase(); invalid.durationMs = NaN;
  expect(compare(invalid, phase(), config).verdict).toBe('ERROR');
});
it('returns PASS only for all checks in every trial, and FAIL for a persistent same-check breach', () => {
  expect(compareTrials(runWith(), config).verdict).toBe('PASS');
  expect(compareTrials(runWith(phase(150)), config).verdict).toBe('FAIL');
  const mixed = runWith(); mixed.trials[1]!.candidate = phase(150);
  expect(compareTrials(mixed, config).verdict).toBe('INCONCLUSIVE');
  const different = runWith(phase(150)); different.trials[1]!.candidate = phase(100, 2000);
  expect(compareTrials(different, config).verdict).toBe('INCONCLUSIVE');
  const incomplete = runWith(); incomplete.trials.pop();
  expect(compareTrials(incomplete, config).verdict).toBe('ERROR');
});
it('never promotes shared-GPU functional validation into performance acceptance', () => {
  const run = runWith(); run.trials[0]!.baseline.environment = { mode: 'functional-shared-gpu' };
  expect(compareTrials(run, config).verdict).toBe('INCONCLUSIVE');
  const badOrder = runWith(); badOrder.trials[1]!.order = ['baseline', 'candidate'];
  expect(compareTrials(badOrder, config).verdict).toBe('ERROR');
});
it('refuses an aged calibration when the current baseline no longer meets its locked limits', () => {
  const run = runWith(); run.trials[0]!.baseline = phase(200);
  expect(compareTrials(run, config).verdict).toBe('PASS');
  const result = compareTrials(run, config, { ttftP95MaxMs: 150, latencyP95MaxMs: 400, responseEnvelopeMs: 1000 });
  expect(result.verdict).toBe('ERROR'); expect(result.validityIssues[0]).toMatchObject({trialId:1});
  expect(result.trials[0]!.verdict).toBe('ERROR'); expect(result.trials[0]!.checks.some(c=>c.metric.includes('locked baseline')&&c.status==='ERROR')).toBe(true);
  expect(result.reason).toContain('Baseline p95 TTFT');
});
