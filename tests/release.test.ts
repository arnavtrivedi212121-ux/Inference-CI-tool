import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockServer } from '../src/mock/server.js';
import type { MockOptions } from '../src/mock/settings.js';
import { testConfig } from './fixtures.js';
function invoke(config: string, json = true) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'compare', '--config', config, ...(json ? ['--json'] : [])], { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish')); }, 25_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
it.each([
  ['healthy', {}, {}, 'PASS', 0],
  ['first-token', {}, { firstTokenDelayMs: 160 }, 'FAIL', 1],
  ['generation', {}, { tokenDelayMs: 70 }, 'FAIL', 1],
  ['HTTP', {}, { errorRate: 1 }, 'FAIL', 1],
  ['disconnect', {}, { disconnectAfterTokens: 3 }, 'FAIL', 1],
  ['timeout', {}, { stall: true }, 'FAIL', 1],
  ['usage', {}, { omitUsage: true }, 'INCONCLUSIVE', 2],
  ['short output', {}, { outputTokens: 2 }, 'INCONCLUSIVE', 2],
  ['baseline', { errorRate: 1 }, {}, 'ERROR', 2],
] satisfies [string, MockOptions, MockOptions, string, number][])('CLI v2: %s', async (_name, b, c, verdict, code) => {
  const options = { port: 0, outputTokens: 6, firstTokenDelayMs: 10, tokenDelayMs: 1 };
  const baseline = await startMockServer({ ...options, ...b }); const candidate = await startMockServer({ ...options, ...c });
  const directory = await mkdtemp(join(tmpdir(), 'inferencegate-release-'));
  try {
    const config = await testConfig(); config.baseline.url = baseline.endpoint; config.candidate.url = candidate.endpoint;
    config.workload = resolve('examples/workloads/smoke.json'); config.run.timeoutMs = 700;
    config.thresholds.ttftP95MaxIncreasePercent = 200; config.thresholds.latencyP95MaxIncreasePercent = 150;
    config.thresholds.throughputMaxDecreasePercent = 30; config.outputDir = join(directory, 'reports');
    const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(config));
    const child = await invoke(path); expect(child.stderr).toBe(''); expect(child.code).toBe(code);
    const report = JSON.parse(child.stdout); expect(report.comparison.verdict).toBe(verdict);
    expect(report.version).toBe(3); expect(report.requestRecordVersion).toBe(2); expect(report.comparison.trials).toHaveLength(3);
    expect(report.assessment.accounting.plannedRequests).toBe(600);
    expect(report.assessment.nextActions.length).toBeGreaterThan(0);
    if (verdict !== 'PASS') expect(report.assessment.findings.length).toBeGreaterThan(0);
    const saved = JSON.parse(await readFile(report.artifacts.json, 'utf8')); expect(saved.comparison).toEqual(report.comparison);
    expect(await readFile(report.artifacts.html, 'utf8')).toContain(`<title>${verdict} ·`);
    const records = (await readFile(report.artifacts.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(600); expect(records.every(record => record.runId === report.runId)).toBe(true);
    const fingerprint = (id: number) => records.filter(record => record.trialId === id).map(record => [record.deployment, record.id, record.plannedOffsetMs]);
    expect(fingerprint(1)).toEqual(fingerprint(3));
    if (verdict === 'PASS') {
      const text = await invoke(path, false); expect(text.stdout).toContain('PASS —'); expect(text.code).toBe(0);
      config.outputDir = join(directory, 'file'); await writeFile(config.outputDir, 'keep'); await writeFile(path, JSON.stringify(config));
      const failed = await invoke(path); expect(failed.code).toBe(2); expect(failed.stdout).toBe(''); expect(failed.stderr).toContain('ERROR:');
      expect(await readFile(config.outputDir, 'utf8')).toBe('keep');
    }
  } finally { await Promise.all([baseline.close(), candidate.close(), rm(directory, { recursive: true, force: true })]); }
}, 30_000);
