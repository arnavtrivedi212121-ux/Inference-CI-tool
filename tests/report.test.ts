import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createReport, renderHtml, writeReports } from '../src/reporting/report.js';
import { runWith, testConfig } from './fixtures.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('writes v3 assessments with v2 trial-tagged raw records without overwriting older runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inferencegate-report-')); directories.push(directory);
  const run = runWith(), config = await testConfig();
  const report = await createReport(run, config);
  const one = await writeReports(report, directory, run);
  const two = await writeReports(await createReport(run, config), directory, run);
  expect(one.directory).not.toBe(two.directory);
  expect(await readdir(directory)).toHaveLength(2);
  const saved = JSON.parse(await readFile(one.json, 'utf8'));
  expect(saved.version).toBe(3); expect(saved.requestRecordVersion).toBe(2); expect(saved.runtime.toolVersion).toBe('0.3.0-dev.3');
  expect(saved.comparison.verdict).toBe('PASS'); expect(saved.planHash).toBe('test-plan');
  expect(saved.phases.map((phase: { id: number }) => phase.id)).toEqual([1, 2, 3]);
  expect(saved.trials).toBeUndefined();
  const raw = (await readFile(one.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(raw).toHaveLength(600); expect(new Set(raw.map(record => record.trialId)).size).toBe(3);
  expect(raw.every(record => record.runId === report.runId && record.version === 2)).toBe(true);
  expect(await readFile(one.html, 'utf8')).toContain('<title>PASS ·');
});
it('escapes text, redacts query values and never saves credential values', async () => {
  const config = await testConfig(); const secret = 'never-save-secret-123';
  config.baseline.url = `http://localhost/v1/chat/completions?api_key=${secret}`;
  config.baseline.model = '</pre><script>alert("injected")</script>';
  config.baseline.apiKeyEnv = 'INFERENCEGATE_REPORT_TEST_KEY';
  process.env.INFERENCEGATE_REPORT_TEST_KEY = secret;
  try {
    const report = await createReport(runWith(), config);
    expect(JSON.stringify(report)).not.toContain(secret);
    const html = renderHtml(report);
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Content-Security-Policy'); expect(html).not.toContain(secret);
    expect(html).toContain('not confidence intervals');
  } finally { delete process.env.INFERENCEGATE_REPORT_TEST_KEY; }
});
it('does not publish when the output parent is a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inferencegate-write-error-')); directories.push(directory);
  const path = join(directory, 'file'); await writeFile(path, 'keep');
  const run = runWith();
  await expect(writeReports(await createReport(run, await testConfig()), path, run)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('keep'); expect(await readdir(directory)).toEqual(['file']);
});
