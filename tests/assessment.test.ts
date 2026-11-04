import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { summarize, compare, compareTrials } from '../src/benchmark/compare.js';
import { assess } from '../src/reporting/assessment.js';
import { createReport, renderHtml } from '../src/reporting/report.js';
import { failRecord, phase, runWith, testConfig } from './fixtures.js';

it('keeps scheduling misses outside the dispatched-request failure denominator', () => {
  const p = phase();
  for (const r of p.records.slice(80)) failRecord(r, 'schedule', 'Concurrency limit prevented planned arrival');
  failRecord(p.records[0]!);
  const s = summarize(p);
  expect(s).toMatchObject({ valid: true, plannedRequests: 100, dispatchedRequests: 80, completedRequests: 79,
    failedRequests: 1, missedArrivals: 20, requestFailureRatePercent: 1.25, scheduleMissRatePercent: 20,
    requestFailures: { http: 1 }, schedulingFailures: { concurrencyLimit: 20, arrivalLag: 0, unknown: 0 } });
  expect(s.plannedRequests).toBe(s.dispatchedRequests + s.missedArrivals);
  expect(s.dispatchedRequests).toBe(s.completedRequests + s.failedRequests);
});

it('does not turn zero dispatched requests into a zero failure rate or PASS', async () => {
  const p = phase(); p.records.forEach(r => failRecord(r, 'schedule', 'Client missed planned arrival tolerance'));
  expect(summarize(p)).toMatchObject({ valid: true, dispatchedRequests: 0, requestFailureRatePercent: null, schedulingFailures: { arrivalLag: 100 } });
  const config = await testConfig(), run = runWith(p);
  const result = compareTrials(run, config);
  expect(result.verdict).toBe('INCONCLUSIVE');
  const assessment = assess(run, result, config);
  expect(assessment.findings.find(f => f.code === 'schedule-arrivalLag')?.evidence[0]?.workloadIds).toEqual(['one']);
});

it('does not allow scheduling misses to hide an unusable baseline', async () => {
  const p = phase(); failRecord(p.records[0]!, 'schedule', 'late'); failRecord(p.records[1]!);
  expect(summarize(p).requestFailureRatePercent).toBeCloseTo(100 / 99);
  expect(compare(p, phase(), await testConfig()).verdict).toBe('ERROR');
});

it('rejects contradictory dispatch and completion records instead of trusting their totals', () => {
  const p = phase(); p.records[0]!.dispatchOffsetMs = null;
  expect(summarize(p).valid).toBe(false);
  const skipped = phase(); skipped.records[0]!.failure = { kind: 'schedule', message: 'late' };
  expect(summarize(skipped).valid).toBe(false);
});

it('reproduces the real overloaded A/A counts and explains the block without inventing endpoint errors', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/overloaded-aa.json', import.meta.url), 'utf8'));
  const config = await testConfig(); config.run.concurrency = 8; config.baselineValidity.minSuccessfulRequests = 200;
  const run = runWith();
  for (const trial of run.trials) for (const [index, target] of (['baseline', 'candidate'] as const).entries()) {
    const p = trial[target];
    p.records = [...phase().records, ...phase().records.map((r, i) => ({ ...r, id: `request-${i + 100}`, plannedOffsetMs: (i + 100) * 3, dispatchOffsetMs: (i + 100) * 3 }))];
    p.records.slice(fixture.completedPerTrial[trial.id - 1][index]).forEach(r => failRecord(r, 'schedule', 'Concurrency limit prevented planned arrival'));
    p.environment = { mode: 'functional-shared-gpu' };
  }
  const report = await createReport(run, config);
  expect(report.comparison.verdict).toBe('INCONCLUSIVE');
  expect(report.assessment.accounting).toMatchObject({ ...fixture.expected, requestFailureRatePercent: 0 });
  expect(report.assessment.releaseDecision).toBe('not-established');
  const finding = report.assessment.findings.find(f => f.code === 'schedule-concurrencyLimit')!;
  expect(finding.evidence.map(e => e.count)).toEqual([66, 51, 53, 49, 43, 44]);
  expect(finding.explanation).toContain('8-request concurrency ceiling');
  expect(finding.nextAction).toContain('baseline only');
  expect(report.assessment.findings.map(f => f.code)).toEqual(expect.arrayContaining(['insufficient-samples', 'functional-only']));
  const html = renderHtml(report);
  expect(html).toContain('Missed arrivals'); expect(html).toContain('<strong>306</strong>'); expect(html).toContain('<strong>894</strong>');
  expect(html).toContain('Dispatched-request failure rate: 0%'); expect(html).toContain('Recommended next action');
});

it.each([
  ['PASS', () => runWith()],
  ['FAIL', () => runWith(phase(150))],
  ['INCONCLUSIVE', () => { const r = runWith(); r.trials[1]!.candidate = phase(150); return r; }],
  ['ERROR', () => { const r = runWith(); r.trials.pop(); return r; }],
] as const)('provides evidence and next actions for %s', async (verdict, makeRun) => {
  const run = makeRun(), config = await testConfig(), comparison = compareTrials(run, config), assessment = assess(run, comparison, config);
  expect(comparison.verdict).toBe(verdict); expect(assessment.nextActions.length).toBeGreaterThan(0);
  if (verdict !== 'PASS') expect(assessment.findings.length).toBeGreaterThan(0);
  expect(assessment.releaseDecision).toBe(({ PASS: 'approved', FAIL: 'rejected', INCONCLUSIVE: 'not-established', ERROR: 'unavailable' })[verdict]);
});

it('distinguishes failed warmup from output comparability and refuses invalid accounting', async () => {
  const config = await testConfig(), run = runWith(); run.trials[0]!.candidate.warmupFailures = 1;
  const report = await createReport(run, config);
  expect(report.assessment.findings.some(f => f.code === 'warmup-failed')).toBe(true);
  expect(report.comparison.trials[0]!.checks[0]!.message).toContain('warmup');
  run.trials[0]!.candidate.records[0]!.dispatchOffsetMs = null;
  expect((await createReport(run, config)).assessment.accounting).toBeNull();
});

it('renders an incomplete evaluation with zero trials as unavailable and explains the missing evidence', async () => {
  const run = runWith(); run.trials = [];
  const report = await createReport(run, await testConfig());
  expect(report.comparison.verdict).toBe('ERROR'); expect(report.assessment.accounting).toBeNull();
  expect(report.assessment.findings[0]!.explanation).toContain('Expected 3 trial pairs; received 0');
  expect(renderHtml(report)).toContain('Decision: unavailable');
});

it('allows policy-compliant request failures without confusing them with scheduling failures', async () => {
  const p = phase(); p.records = [...p.records, ...phase().records.map((r, i) => ({ ...r, id: `request-${i + 100}`, plannedOffsetMs: (i + 100) * 3, dispatchOffsetMs: (i + 100) * 3 }))];
  const candidate = structuredClone(p); failRecord(candidate.records[0]!);
  const report = await createReport(runWith(candidate, p), await testConfig());
  expect(report.comparison.verdict).toBe('PASS'); expect(report.assessment.releaseDecision).toBe('approved');
  expect(report.comparison.trials[0]!.candidate.requestFailureRatePercent).toBe(0.5);
  expect(report.assessment.accounting).toMatchObject({ failedRequests: 3, missedArrivals: 0 });
});
