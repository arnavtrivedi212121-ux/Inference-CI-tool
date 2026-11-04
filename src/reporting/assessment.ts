import type { BenchmarkConfig } from '../config.js';
import type { BenchmarkRun, ScheduledRecord, Target } from '../benchmark/runner.js';
import type { compareTrials } from '../benchmark/compare.js';

export interface Evidence { trialId: number | null; target?: Target; count?: number; workloadIds?: string[]; metric?: string }
export interface Finding { code: string; explanation: string; nextAction: string; evidence: Evidence[] }

/** Deterministic explanations reference measured evidence; they do not infer hardware causes. */
export function assess(run: BenchmarkRun, comparison: ReturnType<typeof compareTrials>, config: BenchmarkConfig) {
  const findings = new Map<string, Finding>();
  const add = (code: string, explanation: string, nextAction: string, evidence: Evidence) => {
    if (!findings.has(code)) findings.set(code, { code, explanation, nextAction, evidence: [] });
    findings.get(code)!.evidence.push(evidence);
  };
  const summaries = comparison.trials.flatMap(trial => [trial.baseline, trial.candidate]);
  const sum = (key: 'plannedRequests' | 'dispatchedRequests' | 'completedRequests' | 'failedRequests' | 'missedArrivals') => summaries.reduce((total, phase) => total + phase[key], 0);
  const accounting = summaries.length && summaries.every(phase => phase.valid) ? {
    plannedRequests: sum('plannedRequests'), dispatchedRequests: sum('dispatchedRequests'), completedRequests: sum('completedRequests'),
    failedRequests: sum('failedRequests'), missedArrivals: sum('missedArrivals'),
    requestFailureRatePercent: sum('dispatchedRequests') ? sum('failedRequests') / sum('dispatchedRequests') * 100 : null,
  } : null;
  for (const [index, trial] of comparison.trials.entries()) {
    for (const target of ['baseline', 'candidate'] as const) {
      const summary = trial[target], phase = run.trials[index]![target];
      const evidence = (count: number, select: (record: ScheduledRecord) => boolean = () => true): Evidence => ({ trialId: trial.id, target, count,
        workloadIds: [...new Set(phase.records.filter(select).map(record => record.workloadId))] });
      for (const [reason, count] of Object.entries(summary.schedulingFailures)) if (count) {
        add(`schedule-${reason}`, reason === 'concurrencyLimit'
          ? `The load generator reached its ${config.run.concurrency}-request concurrency ceiling; affected planned arrivals were not dispatched. This does not establish an endpoint capacity regression.`
          : reason === 'arrivalLag' ? `The client exceeded the ${config.run.maxArrivalLagMs} ms arrival-lag tolerance; affected requests were not dispatched.`
            : 'Planned arrivals were not dispatched; the recorded scheduling reason is unrecognized.',
        'Validate generator capacity separately, calibrate serving load against the baseline only, and lock the plan before comparison. Keep release thresholds unchanged; do not lower load to accommodate the candidate.',
        evidence(count, record => record.failure?.kind === 'schedule' && (reason === 'unknown'
          ? !['Concurrency limit prevented planned arrival', 'Client missed planned arrival tolerance'].includes(record.failure.message)
          : record.failure.message === (reason === 'concurrencyLimit' ? 'Concurrency limit prevented planned arrival' : 'Client missed planned arrival tolerance'))));
      }
      if (summary.completedRequests < config.baselineValidity.minSuccessfulRequests) add('insufficient-samples',
        `Some phases have fewer than ${config.baselineValidity.minSuccessfulRequests} successful requests; their performance checks lack the required samples.`,
        'Correct arrival fidelity or request failures, then collect the required successful samples on both deployments with a locked baseline-calibrated plan.', evidence(summary.completedRequests));
      if (summary.warmupFailures) add('warmup-failed', 'Warmup requests failed, so performance checks cannot rely on the intended warm state.',
        'Inspect warmup failures and endpoint readiness before measuring again; retain the same release thresholds.', { trialId: trial.id, target, count: summary.warmupFailures });
      if (summary.missingUsage) add('missing-usage', 'Successful responses omitted output-token usage; throughput and output-work comparability are unavailable.',
        'Verify streaming usage support and enable usage reporting on the deployment before repeating the locked workload.', evidence(summary.missingUsage, record => record.success && record.completionTokens === null));
      for (const [kind, count] of Object.entries(summary.requestFailures)) add(`request-${kind}`,
        `Dispatched requests had ${kind} failures. Scheduling misses are excluded from this count and its dispatched-request denominator.`,
        'Inspect the affected raw request records and deployment/network logs. Reproduce with the saved plan; these categories alone do not establish a GPU root cause.',
        evidence(count, record => record.failure?.kind === kind));
      if (phase.environment?.mode === 'functional-shared-gpu') add('functional-only', 'This experiment is labelled functional integration on a shared GPU; it cannot establish controlled performance acceptance.',
        'Repeat the locked comparison in an environment meeting the controlled isolation and resource-release checks.', { trialId: trial.id, target });
    }
    const differentOutputs = trial.pairedOutputs.filter(pair => !pair.comparable);
    if (differentOutputs.length) add('incomparable-outputs', 'Paired successful requests differ in output length, usage availability, or finish reason beyond the configured policy.',
      'Inspect the paired outputs and generation/model/tokenizer settings. A faster response doing less completed work cannot establish a performance improvement.',
      { trialId: trial.id, count: differentOutputs.length, workloadIds: [...new Set(differentOutputs.map(pair => pair.workloadId))] });
    for (const check of trial.checks.filter(check => check.status === 'FAIL')) add('threshold-breach',
      'Threshold breaches were observed in the listed trials. FAIL requires the same breach in every valid trial.',
      'Inspect the metric limits, affected trials and paired workload evidence. Reproduce the locked configuration before changing deployment settings.',
      { trialId: trial.id, metric: check.metric });
  }
  if (!config.baseline.deployment?.tokenizerId || config.baseline.deployment.tokenizerId !== config.candidate.deployment?.tokenizerId) {
    add('tokenizer-identity', 'Matching tokenizer identities are missing; performance comparability is not established.',
      'Record the actual tokenizer revisions for both deployments. Different token accounting cannot be treated as equivalent completed work.', { trialId: null });
  }
  for (const issue of comparison.validityIssues) add('evaluation-invalid', comparison.reason,
    'Inspect validity checks, expected trial count/order, plan hashes and raw records. Establish a usable baseline and correct execution before assessing the candidate.',
    { trialId: issue.trialId, metric: issue.message });
  if (comparison.verdict === 'INCONCLUSIVE' && !findings.size) add('mixed-evidence', comparison.reason,
    'Inspect the per-trial checks and environmental conditions; repeat the locked experiment without tuning thresholds to obtain PASS.', { trialId: null });
  const primaryAction = findings.get(comparison.verdict === 'ERROR' ? 'evaluation-invalid' : 'threshold-breach')?.nextAction;
  return { releaseDecision: comparison.verdict === 'PASS' ? 'approved' : comparison.verdict === 'FAIL' ? 'rejected' : comparison.verdict === 'ERROR' ? 'unavailable' : 'not-established',
    summary: comparison.reason, accounting, findings: [...findings.values()],
    nextActions: findings.size ? [...new Set([...(primaryAction ? [primaryAction] : []), ...[...findings.values()].map(finding => finding.nextAction)])]
      : ['Preserve the configuration, workload and artifacts. Approval applies only to the tested conditions and configured checks; it does not establish model quality or production-wide reliability.'] };
}
