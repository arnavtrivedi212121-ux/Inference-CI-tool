import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, loadBenchmarkConfig, parseInput, readJson, workloadSchema } from '../src/config.js';
import { resolveMockSettings, shouldFail } from '../src/mock/settings.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('benchmark input contract', () => {
  it('loads the shipped workload relative to the config, with 100 measured requests', async () => {
    const loaded = await loadBenchmarkConfig('examples/inferencegate.json');
    expect(loaded.measuredRequests).toBe(100);
    expect(loaded.workload.requests).toHaveLength(10);
    expect(loaded.outputDir).toBe(resolve('reports/latest'));
  });

  it.each([
    { version: 1, requests: [] },
    { version: 1, requests: [{ id: 'empty', messages: [] }] },
    { version: 1, requests: [{ id: 'bad-role', messages: [{ role: 'tool', content: 'unsupported' }] }] },
    { version: 1, requests: [
      { id: 'duplicate', messages: [{ role: 'user', content: 'a' }] },
      { id: 'duplicate', messages: [{ role: 'user', content: 'b' }] },
    ] },
  ])('rejects an invalid workload: %j', (value) => {
    expect(() => parseInput(workloadSchema, value, 'Workload')).toThrow('Workload is invalid');
  });

  it('rejects invalid URLs, misspelled fields, and zero concurrency with useful paths', async () => {
    const { config } = await loadBenchmarkConfig('examples/inferencegate.json');
    for (const url of ['ftp://example.com', 'http://user:secret@example.com/v1', 'not-a-url']) {
      expect(configSchema.safeParse({ ...config, baseline: { ...config.baseline, url } }).success).toBe(false);
    }
    expect(() => parseInput(configSchema, { ...config, run: { ...config.run, concurrency: 0 } }, 'Config'))
      .toThrow('run.concurrency');
    expect(configSchema.safeParse({ ...config, threholds: {} }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, thresholds: { ...config.thresholds, throughputMaxDecreasePercent: 101 } }).success).toBe(false);
  });

  it('rejects configurations with too few planned requests for baseline validity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inferencegate-config-'));
    directories.push(directory);
    const { config, workloadPath } = await loadBenchmarkConfig('examples/inferencegate.json');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      ...config, workload: workloadPath, run: { ...config.run, repetitions: 1 },
    }));
    await expect(loadBenchmarkConfig(join(directory, 'config.json'))).rejects.toThrow('minSuccessfulRequests');
  });

  it('accepts UTF-8 BOM JSON from Windows editors and explains malformed JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inferencegate-json-'));
    directories.push(directory);
    const path = join(directory, 'input.json');
    await writeFile(path, '\uFEFF{"version":1}');
    await expect(readJson(path)).resolves.toEqual({ version: 1 });
    await writeFile(path, '{bad');
    await expect(readJson(path)).rejects.toThrow('Invalid JSON');
  });
});

describe('mock configuration and deterministic failures', () => {
  it('applies scenario values and explicit overrides without changing healthy defaults', () => {
    expect(resolveMockSettings('slow-first-token').firstTokenDelayMs).toBe(300);
    expect(resolveMockSettings('slow-first-token', { firstTokenDelayMs: 500 }).firstTokenDelayMs).toBe(500);
    expect(resolveMockSettings('healthy').firstTokenDelayMs).toBe(100);
  });

  it('rejects unknown scenarios and invalid settings', () => {
    expect(() => resolveMockSettings('toString')).toThrow('Unknown scenario');
    expect(() => resolveMockSettings('healthy', { errorRate: 1.5 })).toThrow('errorRate');
    expect(() => resolveMockSettings('healthy', { port: 65536 })).toThrow('port');
    expect(() => resolveMockSettings('healthy', { tokenDelayMs: -1 })).toThrow('tokenDelayMs');
    expect(() => resolveMockSettings('disconnect', { outputTokens: 2 })).toThrow('disconnectAfterTokens');
  });

  it('selects the same failing IDs independent of order, with exact 0% and 100% boundaries', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `request-${index}`);
    const failed = (seed: number, order: string[]) => order.filter((id) => shouldFail(seed, id, 0.2)).sort();
    expect(failed(42, ids)).toEqual(failed(42, [...ids].reverse()));
    expect(failed(42, ids)).not.toEqual(failed(43, ids));
    expect(failed(42, ids).length).toBeGreaterThan(0);
    expect(failed(42, ids).length).toBeLessThan(ids.length);
    expect(ids.some((id) => shouldFail(42, id, 0))).toBe(false);
    expect(ids.every((id) => shouldFail(42, id, 1))).toBe(true);
  });
});
