#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadBenchmarkConfig, parseInput, readJson } from './config.js';
import { startMockServer, type MockServer } from './mock/server.js';
import { resolveMockSettings, scenarios, type MockOptions } from './mock/settings.js';
import { runBenchmark } from './benchmark/runner.js';
import { createReport, writeReports } from './reporting/report.js';
import { runDemo } from './demo.js';
import { validateVllm } from './validation/vllm.js';
import { applyCalibrationLock, calibrationPlanSchema, prepareBenchmark } from './benchmark/calibration.js';

const HELP = `InferenceGate 0.3.0-dev.3 — inference performance release gating

Commands:
  compare       Replay a workload and evaluate release thresholds
  demo          Start mocks, run comparisons, verify reports, and stop mocks
  mock          Start one OpenAI-compatible streaming mock
  mock-pair     Start baseline and candidate mocks together
  validate      Validate a benchmark config and its workload (no HTTP requests)
  validate-vllm Run opt-in real GPU validation (Docker and NVIDIA required)
  validate-generator Test the load generator against local streaming mocks only
  calibrate     Validate generator capacity, then select a baseline-only arrival tier

Examples:
  pnpm mock:pair
  pnpm mock:pair --candidate-scenario slow-first-token
  pnpm mock --port 8002 --scenario errors --error-rate 0.3 --seed 42
  pnpm validate

mock options:
  --scenario <name>             Default: healthy
  --host <host>                 Default: 127.0.0.1
  --port <port>                 Default: 8001 (0 selects a free port)
  --model <name>                Default: mock-model
  --first-token-delay-ms <ms>   Default: 100
  --token-delay-ms <ms>         Default: 5
  --output-tokens <count>       Default: 20 simulated tokens
  --error-rate <fraction>       0–1; deterministic by seed and request ID
  --error-status <status>       Default: 503
  --disconnect-after-tokens <n> Interrupt after n simulated tokens
  --stall                      Send role event, then wait for client cancellation
  --omit-usage                 Omit the final token usage event
  --seed <integer>              Default: 42

mock-pair options:
  --candidate-scenario <name>   Default: healthy; baseline is always healthy
  --baseline-port <port>        Default: 8001
  --candidate-port <port>       Default: 8002
  --seed <integer>              Default: 42

validate options:
  --config <path>               Required; workload paths are relative to this file
  --lock <path>                 Verify a baseline-calibration lock without traffic

Scenarios: ${Object.keys(scenarios).join(', ')}

compare options:
  --config <path>               Required benchmark configuration
  --json                        Print structured measurements and verdict to stdout
  --lock <path>                 Apply and verify a baseline-calibration lock before traffic

validate-generator / calibrate options:
  --config <path>               Required benchmark configuration
  --plan <path>                 Required predeclared calibration policy
  --json                        Print preparation evidence and artifact paths
  Both save preparation.json and measurements.jsonl; only qualifying baseline calibration saves lock.json.

demo options:
  --trials <count>              Trial pairs per comparison, 3–10; default: 5
  --all                         Include disconnect, timeout, missing-usage, broken-baseline
  --output-dir <path>           Default: reports/demo
  --aa-evaluations <count>      Repeat healthy comparisons; report observed false-block rate

validate-vllm options:
  --mode <controlled|functional> Required; functional never approves performance
  --config <path>               Default: examples/vllm.json
  --plan <path>                 Controlled calibration policy; default: examples/calibration-plan.json
  --gpu <index>                 Default: 0
  --candidate-max-sequences <n>  Default: 1 (baseline: 8)
  --aa-evaluations <count>       Default: 3; complete A/A comparisons before config change

Each compare saves report.json, report.html and requests.jsonl in a unique outputDir subdirectory.
Errors exit with code 2. Stop mock servers with Ctrl+C.
`;

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Expected a finite number, received "${value}"`);
  return Number(value);
}

function registerShutdown(servers: MockServer[]) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.all(servers.map((server) => server.close())).catch((error: unknown) => {
      console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'mock') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' },
      scenario: { type: 'string', default: 'healthy' },
      host: { type: 'string' }, port: { type: 'string' }, model: { type: 'string' },
      'first-token-delay-ms': { type: 'string' }, 'token-delay-ms': { type: 'string' },
      'output-tokens': { type: 'string' }, 'error-rate': { type: 'string' },
      'error-status': { type: 'string' }, 'disconnect-after-tokens': { type: 'string' },
      stall: { type: 'boolean' }, 'omit-usage': { type: 'boolean' }, seed: { type: 'string' },
    } });
    if (values.help) { console.log(HELP); return; }
    const overrides: MockOptions = {};
    const numericOptions = {
      port: 'port', 'first-token-delay-ms': 'firstTokenDelayMs', 'token-delay-ms': 'tokenDelayMs',
      'output-tokens': 'outputTokens', 'error-rate': 'errorRate', 'error-status': 'errorStatus',
      'disconnect-after-tokens': 'disconnectAfterTokens', seed: 'seed',
    } as const;
    for (const [flag, key] of Object.entries(numericOptions)) {
      const value = numberOption(values[flag as keyof typeof numericOptions]);
      if (value !== undefined) overrides[key] = value;
    }
    if (values.host !== undefined) overrides.host = values.host;
    if (values.model !== undefined) overrides.model = values.model;
    if (values.stall !== undefined) overrides.stall = values.stall;
    if (values['omit-usage'] !== undefined) overrides.omitUsage = values['omit-usage'];
    const server = await startMockServer(resolveMockSettings(values.scenario, overrides));
    registerShutdown([server]);
    console.log(`Mock (${values.scenario}): ${server.endpoint}`);
    console.log(`Settings: ${JSON.stringify(server.settings)}`);
    return;
  }
  if (command === 'mock-pair') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' },
      'candidate-scenario': { type: 'string', default: 'healthy' },
      'baseline-port': { type: 'string', default: '8001' },
      'candidate-port': { type: 'string', default: '8002' },
      seed: { type: 'string', default: '42' },
    } });
    if (values.help) { console.log(HELP); return; }
    const seed = numberOption(values.seed)!;
    const baselineSettings = resolveMockSettings('healthy', { port: numberOption(values['baseline-port'])!, seed });
    const candidateSettings = resolveMockSettings(values['candidate-scenario'], { port: numberOption(values['candidate-port'])!, seed });
    const baseline = await startMockServer(baselineSettings);
    let candidate: MockServer;
    try {
      candidate = await startMockServer(candidateSettings);
    } catch (error) {
      await baseline.close();
      throw error;
    }
    registerShutdown([baseline, candidate]);
    console.log(`Baseline (healthy): ${baseline.endpoint}`);
    console.log(`Candidate (${values['candidate-scenario']}): ${candidate.endpoint}`);
    console.log(`Seed: ${seed}. Stop both servers with Ctrl+C.`);
    return;
  }
  if (command === 'validate') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' }, config: { type: 'string' }, lock: { type: 'string' },
    } });
    if (values.help) { console.log(HELP); return; }
    if (!values.config) throw new Error('validate requires --config <path>');
    const loaded = await loadBenchmarkConfig(values.config);
    if (values.lock) {
      const locked = await applyCalibrationLock(values.lock, loaded.config, loaded.workload);
      console.log(`Calibration lock verified: ${locked.evidence.calibrationId}; locked arrival interval ${locked.evidence.arrivalIntervalMs} ms.`);
    }
    console.log(`Valid configuration: ${loaded.configPath}`);
    console.log(`Workload: ${loaded.workload.requests.length} entries; ${loaded.measuredRequests} measured requests per phase × ${loaded.config.run.trials} trial pairs.`);
    console.log('Validation only. No benchmark requests were sent.');
    return;
  }
  if (command === 'compare') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' }, config: { type: 'string' }, json: { type: 'boolean' }, lock: { type: 'string' },
    } });
    if (values.help) { console.log(HELP); return; }
    if (!values.config) throw new Error('compare requires --config <path>');
    const loaded = await loadBenchmarkConfig(values.config);
    const { workload } = loaded;
    const locked = values.lock ? await applyCalibrationLock(values.lock, loaded.config, workload) : undefined;
    const config = locked?.config ?? loaded.config;
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Benchmark cancelled'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const run = await runBenchmark(config, workload, controller.signal);
      controller.signal.throwIfAborted();
      const report = await createReport(run, { ...config, workload: loaded.workloadPath, outputDir: loaded.outputDir }, undefined, locked?.evidence);
      const artifacts = await writeReports(report, loaded.outputDir, run);
      controller.signal.throwIfAborted();
      const result = report.comparison;
      if (values.json) console.log(JSON.stringify({ ...report, artifacts }, null, 2));
      else {
        console.log(`${result.verdict} — ${result.reason}; ${run.trials.length} trial pairs`);
        if (locked) console.log(`Calibration lock ${locked.evidence.calibrationId}; effective arrival interval ${config.run.arrivalIntervalMs} ms.`);
        const { assessment } = report;
        if (assessment.accounting) {
          const counts = assessment.accounting;
          console.log(`Planned ${counts.plannedRequests}; dispatched ${counts.dispatchedRequests}; completed ${counts.completedRequests}; missed arrivals ${counts.missedArrivals}; dispatched-request failures ${counts.failedRequests}.`);
        }
        for (const finding of assessment.findings) console.log(`Evidence [${finding.code}]: ${finding.explanation}`);
        for (const action of assessment.nextActions) console.log(`Next: ${action}`);
        for (const trial of result.trials) for (const check of trial.checks) console.log(`Trial ${trial.id} ${check.status}: ${check.message}`);
        console.log(`Workload SHA-256: ${run.workloadHash}`);
        console.log(`HTML report: ${artifacts.html}`);
        console.log(`JSON report: ${artifacts.json}`);
        console.log(`Request records: ${artifacts.requests}`);
      }
      process.exitCode = result.exitCode;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    return;
  }
  if (command === 'validate-generator' || command === 'calibrate') {
    const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, config: { type: 'string' }, plan: { type: 'string' }, json: { type: 'boolean' } } });
    if (values.help) { console.log(HELP); return; }
    if (!values.config || !values.plan) throw new Error(`${command} requires --config <path> and --plan <path>`);
    const loaded = await loadBenchmarkConfig(values.config);
    const plan = parseInput(calibrationPlanSchema, await readJson(values.plan), 'Calibration plan');
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Preparation cancelled'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const result = await prepareBenchmark(loaded.config, loaded.workload, plan, command === 'calibrate' ? 'baseline' : 'generator', loaded.outputDir, controller.signal);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.status} — ${result.kind}; selected interval ${result.selectedIntervalMs ?? 'none'} ms`);
        for (const probe of [result.generator, ...result.probes]) for (const reason of probe.reasons) console.log(`${probe.arrivalIntervalMs} ms: ${reason}`);
        console.log(`Next: ${result.nextAction}`);
        console.log(`Evidence: ${result.artifacts.report}`);
        if (result.artifacts.lock) console.log(`Lock: ${result.artifacts.lock}`);
      }
      process.exitCode = result.exitCode;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (command === 'demo') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' }, trials: { type: 'string', default: '5' },
      all: { type: 'boolean' }, 'output-dir': { type: 'string', default: 'reports/demo' },
      'aa-evaluations': { type: 'string', default: '1' },
    } });
    if (values.help) { console.log(HELP); return; }
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Demo cancelled'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      await runDemo(process.argv[1]!, values['output-dir'], numberOption(values.trials)!, values.all ?? false, controller.signal, numberOption(values['aa-evaluations'])!);
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    }
    return;
  }
  if (command === 'validate-vllm') {
    const { values } = parseArgs({ args, options: {
      help: { type: 'boolean', short: 'h' }, mode: { type: 'string' }, config: { type: 'string', default: 'examples/vllm.json' }, plan: { type: 'string', default: 'examples/calibration-plan.json' },
      gpu: { type: 'string', default: '0' }, 'candidate-max-sequences': { type: 'string', default: '1' }, 'aa-evaluations': { type: 'string', default: '3' },
    } });
    if (values.help) { console.log(HELP); return; }
    if (values.mode !== 'controlled' && values.mode !== 'functional') throw new Error('validate-vllm requires --mode controlled or --mode functional');
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('GPU validation cancelled'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      process.exitCode = await validateVllm({ mode: values.mode, config: values.config, plan: values.plan, gpu: values.gpu,
        candidateMaxSequences: numberOption(values['candidate-max-sequences'])!, aaEvaluations: numberOption(values['aa-evaluations'])! }, controller.signal);
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  throw new Error(`Unknown command "${command}". Run with --help for supported commands.`);
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
