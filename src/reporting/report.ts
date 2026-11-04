import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { redactEndpoint, type BenchmarkConfig } from '../config.js';
import { hash, type BenchmarkRun } from '../benchmark/runner.js';
import { compareTrials, distribution } from '../benchmark/compare.js';
import { assess } from './assessment.js';
import { publishArtifacts } from './artifacts.js';
import type { CalibrationEvidence } from '../benchmark/calibration.js';
export type { BenchmarkRun } from '../benchmark/runner.js';

export async function createReport(run: BenchmarkRun, config: BenchmarkConfig, context?: string, calibration?: CalibrationEvidence) {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const configuration = { ...config, baseline: redactEndpoint(config.baseline), candidate: redactEndpoint(config.candidate) };
  const comparison = compareTrials(run, config, calibration ? { ...calibration.baselineLimits, responseEnvelopeMs: calibration.generatorHoldMs } : undefined);
  return {
    version: 3 as const, requestRecordVersion: 2 as const, runId: randomUUID(), startedAt: run.startedAt, finishedAt: new Date().toISOString(),
    workloadHash: run.workloadHash, planHash: run.planHash, configurationHash: hash(configuration), configuration,
    comparison, assessment: assess(run, comparison, config), calibration: calibration ?? null,
    phases: run.trials.map(trial => ({ id: trial.id, order: trial.order,
      baseline: { planHash: trial.baseline.planHash, environment: trial.baseline.environment ?? null },
      candidate: { planHash: trial.candidate.planHash, environment: trial.candidate.environment ?? null } })),
    runtime: { tool: 'InferenceGate', toolVersion: pkg.version, nodeVersion: process.version, platform: platform(), osRelease: release(), architecture: arch() },
    methodology: { mode: 'repeatability', trials: config.run.trials, percentile: 'nearest-rank',
      arrival: 'Fixed absolute offsets; no hidden queue or retries. Actual arrivals and missed schedules are recorded.',
      requestAccounting: 'Planned = dispatched + missed arrivals. Dispatched = successful completions + dispatched-request failures. Failure rate uses dispatched requests; zero dispatched means unavailable.',
      generatorValidation: calibration ? 'A matching baseline-calibration lock was supplied; actual phase scheduling fidelity remains mandatory.' : 'No baseline-calibration lock was supplied. No prior generator-validation claim is made.',
      timing: 'Dispatch to first nonempty generated text delta; total latency through validated DONE',
      throughput: 'Successful output tokens / complete measured phase seconds, including failures and scheduled idle time; not maximum serving capacity',
      decision: 'Consistency policy, not a statistical confidence estimate. Mixed evidence blocks as INCONCLUSIVE.',
      metadataSource: 'Endpoint deployment metadata is operator supplied; harness environment snapshots are collected at phase boundaries.' },
    context: context ?? null,
  };
}
export type Report = Awaited<ReturnType<typeof createReport>>;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const num = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const badge = (value: string) => `<span class="badge ${escape(value)}">${escape(value)}</span>`;
const table = (head: string[], rows: string[][]) => `<div class="scroll"><table><thead><tr>${head.map(item => `<th>${escape(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export function renderHtml(report: Report) {
  const { comparison: result } = report;
  const trials = result.trials;
  const headline = (target: 'baseline' | 'candidate', metric: 'ttft' | 'throughput' | 'errors') => {
    const values = trials.map(trial => metric === 'ttft' ? trial[target].ttftMs?.p95 : metric === 'throughput' ? trial[target].throughputTokensPerSecond : trial[target].requestFailureRatePercent);
    if (!values.length || values.some(value => value == null)) return 'Unavailable';
    const data = distribution(values as number[])!;
    return `${num(data.p50)} <small>[${num(data.min)}–${num(data.max)}]</small>`;
  };
  const rows = trials.flatMap(trial => trial.checks.map(check => {
    const change = check.baseline === null || check.candidate === null ? null : check.metric.includes('failure') ? check.candidate - check.baseline
      : check.baseline === 0 ? null : (check.candidate - check.baseline) / check.baseline * 100;
    return [String(trial.id), escape(check.metric), num(check.baseline), num(check.candidate), change === null ? 'Unavailable' : `${num(change)} ${check.metric.includes('failure') ? 'pp' : '%'}`, num(check.limit), badge(check.status)];
  }));
  const samples = trials.flatMap(trial => (['baseline', 'candidate'] as const).map(target => {
    const s = trial[target];
    return [String(trial.id), target, String(s.plannedRequests), String(s.dispatchedRequests), String(s.completedRequests), String(s.missedArrivals), String(s.failedRequests), num(s.requestFailureRatePercent),
      num(s.ttftMs?.p95), num(s.latencyMs?.p95), String(s.completionTokens), String(s.missingUsage), escape(JSON.stringify(s.finishReasons)),
      escape(JSON.stringify(s.requestFailures)), escape(JSON.stringify(s.schedulingFailures)), String(s.peakConcurrency), num(s.arrivalLagMs?.max)];
  }));
  const { assessment } = report;
  const counts = assessment.accounting;
  const explanation = assessment.findings.map(finding => `<details><summary>${escape(finding.explanation)}</summary>
    ${table(['Trial', 'Deployment', 'Recorded count', 'Affected workload IDs', 'Metric / validity check'], finding.evidence.map(item => [
      item.trialId === null ? 'Evaluation' : String(item.trialId), escape(item.target ?? 'Both / comparison'), item.count === undefined ? '—' : num(item.count),
      escape(item.workloadIds?.join(', ') ?? 'Phase / evaluation condition'), escape(item.metric ?? '—'),
    ]))}</details>`).join('');
  const evidence = trials.map(trial => `<details><summary>Trial ${trial.id}: ${trial.verdict} · ${trial.order.join(' → ')}</summary>
    <ul>${trial.checks.filter(check => check.status !== 'PASS').map(check => `<li>${escape(check.message)}</li>`).join('') || '<li>Every check passed.</li>'}</ul>
    <p>Paired successful outputs: ${trial.pairedOutputs.length}; noncomparable outputs: ${trial.pairedOutputs.filter(pair => !pair.comparable).length}.</p>
    ${table(['Workload / request', 'Baseline → candidate tokens', 'Finish reasons', 'TTFT delta (ms)', 'Total delta (ms)', 'Comparable'], [...trial.pairedOutputs].sort((a, b) => b.ttftDeltaMs - a.ttftDeltaMs).slice(0, 10).map(pair => [
      escape(`${pair.workloadId} / ${pair.id}`), `${num(pair.baselineTokens)} → ${num(pair.candidateTokens)}`, escape(`${pair.baselineFinish} → ${pair.candidateFinish}`), num(pair.ttftDeltaMs), num(pair.latencyDeltaMs), pair.comparable ? 'Yes' : 'No',
    ]))}<p class="muted">Ten largest paired TTFT deltas. All paired evidence is in report.json; individual measurements are in requests.jsonl. These observations do not identify a GPU root cause.</p></details>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${result.verdict} · InferenceGate comparison</title>
<style>:root{color-scheme:dark;font-family:Segoe UI,Arial,sans-serif;background:#0c111b;color:#e6edf6}*{box-sizing:border-box}main{max-width:1280px;margin:auto;padding:36px 24px}header{border-bottom:1px solid #293247;padding-bottom:18px;font-weight:700;font-size:23px}h1{font-size:34px;letter-spacing:-1px}h2{font-size:20px}p,li{line-height:1.6}.muted,small,th{color:#9baac0}.badge{display:inline-block;font-size:12px;font-weight:800;padding:6px 10px;border-radius:5px}.PASS{background:#113d32;color:#70e5b5}.FAIL{background:#4a232c;color:#ff9ba7}.ERROR,.INCONCLUSIVE{background:#493d1b;color:#f0d17c}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card,section{background:#141d2b;border:1px solid #293247;border-radius:10px;padding:20px;margin:18px 0}.card strong{display:block;font-size:20px;margin-top:12px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:12px}td,th{padding:12px 9px;border-bottom:1px solid #293247;white-space:nowrap}th{text-transform:uppercase;font-size:10px}a{color:#9ec6ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}details{margin:14px 0}summary{cursor:pointer;font-weight:600}code{overflow-wrap:anywhere}@media(max-width:700px){.cards{grid-template-columns:1fr}h1{font-size:27px}}@media print{:root{color-scheme:light;background:white;color:#152032}.card,section{background:white}main{padding:0}}</style></head>
<body><main><header>InferenceGate / release verification <small>v${escape(report.runtime.toolVersion)}</small></header>
<h1>${badge(result.verdict)} Release assessment</h1><p>${escape(assessment.summary)}</p><p class="muted">${trials.length} trial pairs · fixed plan · alternating order · concurrency ${report.configuration.run.concurrency} · ${report.configuration.run.arrivalIntervalMs} ms arrival interval · exit ${result.exitCode}</p>
${report.context ? `<p>${escape(report.context)}</p>` : ''}
<p class="muted">${escape(report.methodology.generatorValidation)}${report.calibration ? ` Calibration ${escape(report.calibration.calibrationId)}; locked interval ${report.calibration.arrivalIntervalMs} ms; generator hold ${report.calibration.generatorHoldMs} ms.` : ''}</p>
<div class="cards">${(['completedRequests', 'missedArrivals', 'failedRequests'] as const).map((key, i) => `<div class="card">${['Successful completions', 'Missed arrivals', 'Dispatched-request failures'][i]}<strong>${num(counts?.[key])}</strong><small>Across all measured phases; warmup excluded.</small></div>`).join('')}</div>
<section><h2>Decision: ${escape(assessment.releaseDecision.replaceAll('-', ' '))}</h2><p>Planned: ${num(counts?.plannedRequests)} · Dispatched: ${num(counts?.dispatchedRequests)} · Dispatched-request failure rate: ${num(counts?.requestFailureRatePercent)}${counts?.requestFailureRatePercent == null ? '' : '%'}. Missed arrivals are excluded from that failure rate.</p>
<h2>Recommended next action</h2><p>${escape(assessment.nextActions[0])}</p>
${assessment.nextActions.length > 1 ? `<details><summary>Additional actions</summary><ol>${assessment.nextActions.slice(1).map(action => `<li>${escape(action)}</li>`).join('')}</ol></details>` : ''}
<h2>Evidence behind the assessment</h2>${explanation || '<p>Every required check passed in every trial under the recorded conditions.</p>'}</section>
<h2>Observed measurements</h2><p class="muted">Descriptive values below do not override the assessment or make invalid comparisons acceptable.</p>
<div class="cards">${(['ttft', 'throughput', 'errors'] as const).map((metric, i) => `<div class="card">${['Median trial p95 TTFT (ms)', 'Median trial throughput (tok/s)', 'Median trial dispatched-request failure rate (%)'][i]}<strong>${headline('baseline', metric)} → ${headline('candidate', metric)}</strong><small>Baseline → candidate; brackets show trial range, not confidence intervals.</small></div>`).join('')}</div>
<section><h2>Consistency across trials</h2>${table(['Check', ...trials.map(trial => `Trial ${trial.id}`)], result.consistency.map(check => [escape(check.metric), ...check.outcomes.map(badge)]))}<p>PASS requires all checks in all trials. FAIL requires the same breach in every valid trial. Mixed or insufficient evidence is INCONCLUSIVE. Execution failures and unusable baselines are ERROR. Both block with exit 2.</p></section>
<section><h2>Threshold evidence</h2>${table(['Trial', 'Metric', 'Baseline', 'Candidate', 'Change', 'Allowed limit', 'Result'], rows)}<p class="muted">Latency and error checks specify maxima; throughput specifies a minimum. Equality passes. Failure-rate differences use percentage points. Locked baseline checks apply to the baseline alone.</p></section>
<section><h2>Samples, completed work, and arrival fidelity</h2>${table(['Trial', 'Deployment', 'Planned', 'Dispatched', 'Completed', 'Missed arrivals', 'Request failures', 'Request failure %', 'P95 TTFT ms', 'P95 total ms', 'Known tokens', 'Missing usage', 'Finish reasons', 'Request failure categories', 'Scheduling categories', 'Peak in flight', 'Max arrival lag ms'], samples)}<p class="muted">Planned = dispatched + missed arrivals. Dispatched = successful completions + dispatched-request failures. At least ${report.configuration.baselineValidity.minSuccessfulRequests} successful requests are required on both sides for performance checks. Unknown token totals are incomplete. Scheduler misses invalidate performance comparisons.</p></section>
<section><h2>Affected workload and paired evidence</h2>${evidence}</section>
<section><h2>Reproduce and inspect</h2><p><a href="report.json">Structured report</a> · <a href="requests.jsonl">Raw request measurements</a></p><pre>Run: ${escape(report.runId)}
Started: ${escape(report.startedAt)}
Finished: ${escape(report.finishedAt)}
Workload SHA-256: ${escape(report.workloadHash)}
Effective plan SHA-256: ${escape(report.planHash)}
Redacted configuration SHA-256: ${escape(report.configurationHash)}
Runtime: ${escape(JSON.stringify(report.runtime))}</pre><details><summary>Configuration and deployment metadata (operator supplied)</summary><pre>${escape(JSON.stringify(report.configuration, null, 2))}</pre></details><details><summary>Phase environment snapshots</summary><pre>${escape(JSON.stringify(report.phases, null, 2))}</pre></details><p>Consistency is not statistical significance. Record hardware, runtime, model and tokenizer revisions, isolate comparison environments, and evaluate false-block rates before enforcing this policy. Token and finish comparisons do not evaluate answer quality.</p></section>
<p class="muted">Report schema v3 · Raw request schema v2 · No credential values, prompts or generated response text are included. URLs have query values redacted.</p></main></body></html>`;
}

export async function writeReports(report: Report, outputDirectory: string, run: BenchmarkRun) {
  const records = run.trials.flatMap(trial => (['baseline', 'candidate'] as const).flatMap(deployment => trial[deployment].records.map(record =>
    JSON.stringify({ version: 2, runId: report.runId, trialId: trial.id, deployment, ...record }))));
  const destination = await publishArtifacts(outputDirectory, `${report.startedAt.replace(/[:.]/g, '-')}-${report.runId}`, {
    'report.json': JSON.stringify(report, null, 2) + '\n', 'report.html': renderHtml(report), 'requests.jsonl': records.join('\n') + '\n',
  });
  return { directory: destination, json: join(destination, 'report.json'), html: join(destination, 'report.html'), requests: join(destination, 'requests.jsonl') };
}
