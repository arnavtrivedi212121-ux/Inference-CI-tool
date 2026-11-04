import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCalibrationLock, calibrationPlanSchema, prepareBenchmark, type CalibrationPlan } from '../src/benchmark/calibration.js';
import { workloadSchema } from '../src/config.js';
import { hash, replayPlan } from '../src/benchmark/runner.js';
import { testConfig } from './fixtures.js';

const directories: string[] = [], servers: Server[] = [];
const workload = workloadSchema.parse({ version: 1, requests: [{ id: 'one', messages: [{ role: 'user', content: 'Hello' }], generation: { max_tokens: 4, temperature: 0 } }] });
const policy: CalibrationPlan = { version: 1, arrivalIntervalsMs: [1, 2, 4], generatorHoldMs: 600,
  baselineLimits: { ttftP95MaxMs: 500, latencyP95MaxMs: 600 } };
let config: Awaited<ReturnType<typeof testConfig>>;
let result: Awaited<ReturnType<typeof prepareBenchmark>>;
let baselineCalls = 0, candidateCalls = 0;
async function directory() { const d = await mkdtemp(join(tmpdir(), 'inferencegate-calibration-')); directories.push(d); return d; }
async function endpoint(server: Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}/v1/chat/completions`; }
beforeAll(async () => {
  config = await testConfig(); config.run = { ...config.run, repetitions: 200, concurrency: 256, timeoutMs: 1000, arrivalIntervalMs: 1 };
  config.baselineValidity.minSuccessfulRequests = 200;
  const stream = 'data: '+JSON.stringify({choices:[{index:0,delta:{content:'hello'},finish_reason:null}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[],usage:{completion_tokens:1}})+'\n\ndata: [DONE]\n\n';
  config.baseline.url = await endpoint(createServer((req,res) => { req.resume(); req.on('end', () => {
    baselineCalls++;
    // A deterministic rejected first tier tests selection without relying on noisy timing.
    if (baselineCalls <= 600) { res.writeHead(503); res.end(); }
    else { res.writeHead(200, {'content-type':'text/event-stream'}); res.end(stream); }
  }); }));
  config.baseline.url += '?key=do-not-save-query-value';
  config.candidate.url = await endpoint(createServer((_req,res) => { candidateCalls++; res.writeHead(503); res.end(); }));
  config.candidate.apiKeyEnv = 'INFERENCEGATE_CALIBRATION_MUST_NOT_READ'; delete process.env.INFERENCEGATE_CALIBRATION_MUST_NOT_READ;
  result = await prepareBenchmark(config, workload, policy, 'baseline', await directory());
}, 30_000);
afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(directories.map(d => rm(d, { recursive: true, force: true })));
});

it('retains rejected baseline tiers, chooses the first qualifying tier, and never touches the candidate', async () => {
  expect(result.status).toBe('READY'); expect(result.selectedIntervalMs).toBe(2);
  expect(result.generator.accepted).toBe(true); expect(result.probes.map(p => p.accepted)).toEqual([false, true]);
  expect(result.probes[0]!.reasons.join(' ')).toContain('dispatched requests failed');
  expect(baselineCalls).toBe(1200); expect(candidateCalls).toBe(0);
  expect(result.probes[1]!.phases.every(p => p.summary.completedRequests === 200 && p.summary.missedArrivals === 0)).toBe(true);
  expect((await readdir(result.artifacts.directory)).sort()).toEqual(['lock.json','measurements.jsonl','preparation.json']);
  const saved = await readFile(result.artifacts.report, 'utf8'); expect(saved).not.toContain('do-not-save-query-value'); expect(saved).not.toContain(config.candidate.url);
  const raw = (await readFile(result.artifacts.measurements,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(raw).toHaveLength(1800); expect(raw.every(r=>r.version===1&&r.preparationId===result.preparationId)).toBe(true);
});

it('locks workload, baseline, run settings and release thresholds while allowing a new candidate/output path', async () => {
  const changed = structuredClone(config); changed.candidate.url = 'http://localhost:9999/v1/chat/completions'; changed.outputDir = 'elsewhere';
  const applied = await applyCalibrationLock(result.artifacts.lock!, changed, workload);
  expect(applied.config.run.arrivalIntervalMs).toBe(2); expect(applied.evidence.calibrationId).toBe(result.preparationId);
  for (const mutate of [
    (c: typeof config) => { c.run.seed++; }, (c: typeof config) => { c.run.concurrency++; },
    (c: typeof config) => { c.run.timeoutMs++; }, (c: typeof config) => { c.run.warmupRequests++; },
    (c: typeof config) => { c.thresholds.ttftP95MaxIncreasePercent++; }, (c: typeof config) => { c.baseline.model = 'other'; },
  ]) { const c = structuredClone(config); mutate(c); await expect(applyCalibrationLock(result.artifacts.lock!, c, workload)).rejects.toThrow(/lock mismatch|report settings/); }
  const differentWorkload = structuredClone(workload); differentWorkload.requests[0]!.generation.max_tokens++;
  await expect(applyCalibrationLock(result.artifacts.lock!, config, differentWorkload)).rejects.toThrow('lock mismatch');
});

it('detects changed or mismatched calibration artifacts before comparison', async () => {
  const dir = await directory(), lock = JSON.parse(await readFile(result.artifacts.lock!, 'utf8'));
  await writeFile(join(dir, 'lock.json'), JSON.stringify(lock));
  const proof = JSON.parse(await readFile(result.artifacts.report, 'utf8')); proof.generator.accepted = false;
  await writeFile(join(dir, 'preparation.json'), JSON.stringify(proof));
  await expect(applyCalibrationLock(join(dir,'lock.json'),config,workload)).rejects.toThrow('evidence');
});

it('cannot reuse a valid report for a lock that binds different release thresholds', async () => {
  const dir = await directory(), lock = JSON.parse(await readFile(result.artifacts.lock!, 'utf8'));
  const changed = structuredClone(config); changed.thresholds.ttftP95MaxIncreasePercent = 500;
  lock.bindingHash = hash({ baseline: changed.baseline, run: {...changed.run,arrivalIntervalMs:lock.arrivalIntervalMs}, thresholds: changed.thresholds,
    baselineValidity: changed.baselineValidity, comparability: changed.comparability, workloadHash:hash(workload) });
  lock.planHash = hash(replayPlan(workload,changed.run.repetitions,changed.run.seed,lock.arrivalIntervalMs));
  await writeFile(join(dir,'lock.json'),JSON.stringify(lock)); await writeFile(join(dir,'preparation.json'),await readFile(result.artifacts.report));
  await expect(applyCalibrationLock(join(dir,'lock.json'),changed,workload)).rejects.toThrow('report settings');
});

it('rejects an insufficient generator concurrency bound without deployment traffic or a lock', async () => {
  const c = structuredClone(config); c.run.concurrency = 8;
  const calls = baselineCalls;
  const r = await prepareBenchmark(c,workload,policy,'baseline',await directory());
  expect(r.status).toBe('INCONCLUSIVE'); expect(r.generator.phases).toHaveLength(0); expect(r.probes).toHaveLength(0);
  expect(r.artifacts.lock).toBeNull(); expect(baselineCalls).toBe(calls); expect(candidateCalls).toBe(0);
  expect(r.generator.reasons[0]).toContain('bound');
});

it('includes allowed arrival lag in the generator concurrency budget', async () => {
  const c = structuredClone(config); c.run = {...c.run,concurrency:100,timeoutMs:500,maxArrivalLagMs:1000};
  const p:CalibrationPlan={version:1,arrivalIntervalsMs:[10],generatorHoldMs:100,baselineLimits:{ttftP95MaxMs:100,latencyP95MaxMs:100}};
  const r=await prepareBenchmark(c,workload,p,'generator',await directory());
  expect(r.requiredConcurrency).toBe(151);expect(r.status).toBe('INCONCLUSIVE');expect(r.generator.phases).toHaveLength(0);
});

it('generator-only validation requires neither baseline nor candidate credentials and cannot publish a serving lock', async () => {
  const c = structuredClone(config); c.baseline.apiKeyEnv = 'INFERENCEGATE_CALIBRATION_MUST_NOT_READ';
  const calls = baselineCalls, r = await prepareBenchmark(c,workload,policy,'generator',await directory());
  expect(r.status).toBe('READY'); expect(r.probes).toHaveLength(0); expect(r.artifacts.lock).toBeNull();
  expect(baselineCalls).toBe(calls); expect(candidateCalls).toBe(0);
}, 15_000);

it('records cancellation as ERROR and publishes no usable lock', async () => {
  const controller = new AbortController(), calls = baselineCalls;
  const timer = setTimeout(() => controller.abort(new Error('Preparation cancelled')), 30);
  try {
    const r = await prepareBenchmark(config,workload,policy,'baseline',await directory(),controller.signal);
    expect(r.status).toBe('ERROR'); expect(r.artifacts.lock).toBeNull(); expect(r.error).toBe('Preparation cancelled');
    expect(baselineCalls).toBe(calls);
    expect(JSON.parse(await readFile(r.artifacts.report,'utf8')).status).toBe('ERROR');
    expect(await readdir(r.artifacts.directory)).not.toContain('lock.json');
  } finally { clearTimeout(timer); }
});

it('requires ordered, bounded, predeclared tiers and a response envelope covering the baseline limits', () => {
  for (const p of [{...policy,arrivalIntervalsMs:[2,1]}, {...policy,arrivalIntervalsMs:[1,1]}, {...policy,generatorHoldMs:50}, {...policy,arrivalIntervalsMs:[0]}]) expect(calibrationPlanSchema.safeParse(p).success).toBe(false);
});

it('the actual CLI verifies a lock without traffic and keeps its plan when the candidate fails', async () => {
  const dir = await directory(), c = structuredClone(config);
  c.workload = join(dir,'workload.json'); c.outputDir = join(dir,'comparison'); c.run.arrivalIntervalMs = 999;
  delete c.candidate.apiKeyEnv;
  await writeFile(c.workload,JSON.stringify(workload)); await writeFile(join(dir,'config.json'),JSON.stringify(c));
  const invoke = (command: string) => new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject) => {
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts',command,'--config',join(dir,'config.json'),'--lock',result.artifacts.lock!,...(command==='compare'?['--json']:[])],{windowsHide:true});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Locked CLI timed out'))},25000);
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
  });
  const beforeBaseline=baselineCalls,beforeCandidate=candidateCalls;
  const validation=await invoke('validate');expect(validation.code).toBe(0);expect(validation.stdout).toContain('locked arrival interval 2 ms');
  expect(baselineCalls).toBe(beforeBaseline);expect(candidateCalls).toBe(beforeCandidate);
  const comparison=await invoke('compare');expect(comparison.stderr).toBe('');expect(comparison.code).toBe(1);
  const report=JSON.parse(comparison.stdout);expect(report.comparison.verdict).toBe('FAIL');
  expect(report.configuration.run.arrivalIntervalMs).toBe(2);expect(report.configuration.thresholds).toEqual(config.thresholds);
  expect(report.calibration.calibrationId).toBe(result.preparationId);
  const lock=JSON.parse(await readFile(result.artifacts.lock!,'utf8'));expect(report.planHash).toBe(lock.planHash);
  expect(report.comparison.trials.every((t:{baseline:{missedArrivals:number};candidate:{missedArrivals:number}})=>t.baseline.missedArrivals===0&&t.candidate.missedArrivals===0)).toBe(true);
  expect(candidateCalls-beforeCandidate).toBe(600);expect(baselineCalls-beforeBaseline).toBe(600);
},30000);
