import type { BenchmarkConfig } from '../config.js';
import type { BenchmarkRun, PhaseResult } from './runner.js';

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR';
export function distribution(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  return { count: sorted.length, min: sorted[0]!, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1)!, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}
export function summarize(phase: PhaseResult) {
  const successes = phase.records.filter(record => record.success);
  const missed = phase.records.filter(record => record.failure?.kind === 'schedule');
  const dispatchedRequests = phase.records.length - missed.length;
  const failedRequests = dispatchedRequests - successes.length;
  const valid = phase.records.length > 0 && Number.isFinite(phase.durationMs) && phase.durationMs > 0 && phase.records.every(record =>
    Number.isFinite(record.plannedOffsetMs) && record.plannedOffsetMs >= 0 && Number.isFinite(record.arrivalLagMs) && record.arrivalLagMs! >= 0
    && (record.failure?.kind === 'schedule' ? record.dispatchOffsetMs === null && !record.completed && !record.success
      : record.dispatchOffsetMs !== null && Number.isFinite(record.dispatchOffsetMs) && record.dispatchOffsetMs >= 0)
    && Number.isFinite(record.latencyMs) && record.latencyMs >= 0 && (record.success
      ? record.completed && record.failure === null && ['stop', 'length'].includes(record.finishReason!) && record.ttftMs !== null && Number.isFinite(record.ttftMs)
        && record.ttftMs >= 0 && record.ttftMs <= record.latencyMs
        && (record.completionTokens === null || Number.isSafeInteger(record.completionTokens) && record.completionTokens > 0)
      : record.failure !== null && !record.completed && record.completionTokens === null));
  const requestFailures: Record<string, number> = {};
  for (const record of phase.records) if (record.failure && record.failure.kind !== 'schedule') requestFailures[record.failure.kind] = (requestFailures[record.failure.kind] ?? 0) + 1;
  const concurrencyLimit = missed.filter(record => record.failure!.message === 'Concurrency limit prevented planned arrival').length;
  const arrivalLag = missed.filter(record => record.failure!.message === 'Client missed planned arrival tolerance').length;
  const tokens = successes.reduce((sum, record) => sum + (record.completionTokens ?? 0), 0);
  return { valid, plannedRequests: phase.records.length, dispatchedRequests, completedRequests: successes.length, failedRequests,
    missedArrivals: missed.length, requestFailures, schedulingFailures: { concurrencyLimit, arrivalLag, unknown: missed.length - concurrencyLimit - arrivalLag },
    requestFailureRatePercent: dispatchedRequests ? failedRequests / dispatchedRequests * 100 : null,
    scheduleMissRatePercent: phase.records.length ? missed.length / phase.records.length * 100 : null,
    ttftMs: distribution(successes.map(record => record.ttftMs!)), latencyMs: distribution(successes.map(record => record.latencyMs)),
    completionTokens: tokens, missingUsage: successes.filter(record => record.completionTokens === null).length,
    throughputTokensPerSecond: valid && successes.length > 0 && successes.every(record => record.completionTokens !== null) ? tokens / (phase.durationMs / 1000) : null,
    durationMs: phase.durationMs, warmupFailures: phase.warmupFailures, peakConcurrency: phase.peakConcurrency,
    arrivalLagMs: distribution(phase.records.map(record => record.arrivalLagMs).filter((value): value is number => value !== null)),
    finishReasons: { stop: successes.filter(record => record.finishReason === 'stop').length, length: successes.filter(record => record.finishReason === 'length').length },
  };
}
export interface Check {
  metric: string; status: Verdict; baseline: number | null; candidate: number | null; limit: number | null; message: string;
}
export function compare(baselinePhase: PhaseResult, candidatePhase: PhaseResult, config: BenchmarkConfig) {
  const baseline = summarize(baselinePhase), candidate = summarize(candidatePhase);
  const checks: Check[] = [];
  const expected = baselinePhase.planHash === candidatePhase.planHash && baseline.plannedRequests === candidate.plannedRequests
    && new Set(baselinePhase.records.map(record => record.id)).size === baseline.plannedRequests
    && new Set(candidatePhase.records.map(record => record.id)).size === candidate.plannedRequests
    && baselinePhase.records.every((record, index) => record.id === candidatePhase.records[index]?.id
      && record.workloadId === candidatePhase.records[index]?.workloadId && record.plannedOffsetMs === candidatePhase.records[index]?.plannedOffsetMs);
  const invalid = !baseline.valid || !candidate.valid || !expected;
  const invalidBaseline = baseline.requestFailureRatePercent !== null && baseline.requestFailureRatePercent > config.baselineValidity.maxErrorRatePercent;
  const paired = baselinePhase.records.flatMap((b, index) => {
    const c = candidatePhase.records[index];
    if (!b.success || !c?.success) return [];
    const delta = b.completionTokens === null || c.completionTokens === null ? null : Math.abs(c.completionTokens - b.completionTokens) / b.completionTokens * 100;
    return [{ id: b.id, workloadId: b.workloadId, baselineTokens: b.completionTokens, candidateTokens: c.completionTokens,
      baselineFinish: b.finishReason, candidateFinish: c.finishReason, tokenDifferencePercent: delta,
      comparable: delta !== null && delta <= config.comparability.maxOutputTokenDifferencePercent && b.finishReason === c.finishReason,
      ttftDeltaMs: c.ttftMs! - b.ttftMs!, latencyDeltaMs: c.latencyMs - b.latencyMs }];
  });
  if (invalid || invalidBaseline) {
    checks.push({ metric: 'validity', status: 'ERROR', baseline: null, candidate: null, limit: null,
      message: !expected ? 'Effective request plans do not match' : invalidBaseline ? 'Baseline exceeds its dispatched-request failure ceiling' : 'Invalid measurement records' });
  } else if (baseline.missedArrivals || candidate.missedArrivals) {
    checks.push({ metric: 'execution conditions', status: 'INCONCLUSIVE', baseline: null, candidate: null, limit: null,
      message: 'The fixed arrival schedule was not maintained. Validate generator capacity separately and calibrate against the baseline only; preserve thresholds and the candidate comparison plan.' });
  } else {
    const tokenizerKnown = config.baseline.deployment?.tokenizerId !== undefined && config.baseline.deployment.tokenizerId === config.candidate.deployment?.tokenizerId;
    const workComparable = tokenizerKnown && paired.every(record => record.comparable) && !baseline.warmupFailures && !candidate.warmupFailures;
    const samples = baseline.completedRequests >= config.baselineValidity.minSuccessfulRequests && candidate.completedRequests >= config.baselineValidity.minSuccessfulRequests;
    const add = (metric: string, b: number | null, c: number | null, limit: number | null, lower = true, available = true) => {
      const status: Verdict = !available || b === null || c === null || limit === null ? 'INCONCLUSIVE' : (lower ? c > limit : c < limit) ? 'FAIL' : 'PASS';
      checks.push({ metric, status, baseline: b, candidate: c, limit,
        message: status === 'INCONCLUSIVE' ? `${metric}: ${!samples ? 'insufficient successful samples on baseline or candidate' : baseline.warmupFailures || candidate.warmupFailures ? 'warmup did not complete successfully' : !tokenizerKnown ? 'matching tokenizer identities are required' : !workComparable ? 'paired output lengths, usage, or finish reasons are not comparable' : 'required measurement unavailable'}`
          : `${metric}: baseline ${b!.toFixed(3)}, candidate ${c!.toFixed(3)}; ${lower ? 'maximum' : 'minimum'} allowed ${limit!.toFixed(3)}` });
    };
    const t = config.thresholds;
    const latency = (name: string, b: number | null, c: number | null, increase: number) => add(name, b, c, b === null ? null : b * (1 + increase / 100), true, samples && workComparable);
    latency('p95 first-token latency (ms)', baseline.ttftMs?.p95 ?? null, candidate.ttftMs?.p95 ?? null, t.ttftP95MaxIncreasePercent);
    latency('p95 total latency (ms)', baseline.latencyMs?.p95 ?? null, candidate.latencyMs?.p95 ?? null, t.latencyP95MaxIncreasePercent);
    const b = baseline.throughputTokensPerSecond;
    add('output throughput (tok/s)', b, candidate.throughputTokensPerSecond, b === null ? null : b * (1 - t.throughputMaxDecreasePercent / 100), false, samples && workComparable);
    add('request failure-rate increase (percentage points)', baseline.requestFailureRatePercent, candidate.requestFailureRatePercent, baseline.requestFailureRatePercent! + t.errorRateMaxIncreasePercentagePoints);
    add('candidate request failure rate (%)', baseline.requestFailureRatePercent, candidate.requestFailureRatePercent, t.candidateMaxErrorRatePercent);
  }
  const verdict: Verdict = checks.some(check => check.status === 'ERROR') ? 'ERROR' : checks.some(check => check.status === 'FAIL') ? 'FAIL'
    : checks.some(check => check.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS';
  return { baseline, candidate, checks, pairedOutputs: paired, verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2 };
}

export function compareTrials(run: BenchmarkRun, config: BenchmarkConfig, lockedBaseline?: { ttftP95MaxMs: number; latencyP95MaxMs: number; responseEnvelopeMs: number }) {
  const trials = run.trials.map(trial => ({ id: trial.id, order: trial.order, ...compare(trial.baseline, trial.candidate, config) }));
  const validityIssues: { trialId: number | null; message: string }[] = [];
  if (trials.length !== config.run.trials) validityIssues.push({ trialId: null, message: `Expected ${config.run.trials} trial pairs; received ${trials.length}` });
  if (new Set(trials.map(trial => trial.id)).size !== trials.length) validityIssues.push({ trialId: null, message: 'Duplicate trial IDs' });
  for (const [index, trial] of run.trials.entries()) {
    const baseline = trials[index]!.baseline;
    if (lockedBaseline && baseline.valid && !baseline.missedArrivals && !baseline.warmupFailures && baseline.completedRequests >= config.baselineValidity.minSuccessfulRequests) {
      for (const [name, actual, limit] of [
        ['p95 TTFT', baseline.ttftMs?.p95, lockedBaseline.ttftP95MaxMs],
        ['p95 total latency', baseline.latencyMs?.p95, lockedBaseline.latencyP95MaxMs],
        ['maximum response latency', baseline.latencyMs?.max, lockedBaseline.responseEnvelopeMs],
      ] as const) if (actual !== undefined) {
        const status = actual > limit ? 'ERROR' : 'PASS';
        trials[index]!.checks.push({ metric: `locked baseline ${name} (ms)`, status, baseline: actual, candidate: null, limit,
          message: status === 'ERROR' ? `Baseline ${name} ${actual.toFixed(3)} ms exceeds its locked calibration limit ${limit} ms; baseline usability is not established`
            : `Baseline ${name} ${actual.toFixed(3)} ms is within its locked calibration limit ${limit} ms` });
        if (status === 'ERROR') { trials[index]!.verdict = 'ERROR'; trials[index]!.exitCode = 2; }
      }
    }
    if (trial.id !== index + 1 || trial.order.join(',') !== (index % 2 ? 'candidate,baseline' : 'baseline,candidate')) validityIssues.push({ trialId: trial.id, message: 'Unexpected trial ID or phase order' });
    if (trial.baseline.planHash !== run.planHash || trial.candidate.planHash !== run.planHash) validityIssues.push({ trialId: trial.id, message: 'Phase plan hashes differ from the run plan hash' });
    for (const check of trials[index]!.checks.filter(check => check.status === 'ERROR')) validityIssues.push({ trialId: trial.id, message: check.message });
  }
  const invalid = validityIssues.length > 0;
  const functionalOnly = run.trials.some(trial => [trial.baseline, trial.candidate].some(phase => phase.environment?.mode === 'functional-shared-gpu'));
  const persistent = trials[0]?.checks.filter(check => check.status === 'FAIL' && trials.every(trial => trial.checks.some(other => other.metric === check.metric && other.status === 'FAIL'))) ?? [];
  const verdict: Verdict = invalid ? 'ERROR' : functionalOnly ? 'INCONCLUSIVE' : persistent.length ? 'FAIL' : trials.every(trial => trial.verdict === 'PASS') ? 'PASS' : 'INCONCLUSIVE';
  const reason = invalid ? [...new Set(validityIssues.map(issue => issue.message))].join('; ') : functionalOnly ? 'Functional integration only: shared-GPU resident servers cannot establish performance acceptance' : verdict === 'PASS' ? 'Every required check passed in every trial'
    : verdict === 'FAIL' ? `Persistent breach in every trial: ${persistent.map(check => check.metric).join(', ')}` : 'Valid trials contain conflicting or insufficient evidence; release remains blocked';
  return { verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2, reason, trials, validityIssues,
    consistency: [...new Set(trials.flatMap(trial => trial.checks.map(check => check.metric)))].map(metric => ({ metric,
      outcomes: trials.map(trial => trial.checks.find(check => check.metric === metric)?.status ?? 'INCONCLUSIVE') })),
  };
}
