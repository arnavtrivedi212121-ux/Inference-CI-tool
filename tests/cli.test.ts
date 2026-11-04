import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const children = new Set<ChildProcess>();

function launch(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (value: string) => { stdout += value; });
  child.stderr!.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); });
  });
  return { child, done, output: () => stdout };
}

afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.kill();
  })));
});

describe('CLI process contract', () => {
  it('validates the shipped configuration without starting a server', async () => {
    const result = await launch(['validate', '--config', 'examples/inferencegate.json']).done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('100 measured requests per phase');
    expect(result.stdout).toContain('No benchmark requests were sent');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['compare'],
    ['validate'],
    ['mock', '--scenario', 'invalid'],
    ['mock', '--port', '-1'],
    ['mock', '--error-rate', 'NaN'],
    ['mock', '--misspelled-option', '4'],
    ['mock-pair', '--candidate-scenario', 'invalid'],
    ['demo', '--trials', '0'],
    ['demo', '--trials', '1.5'],
    ['validate-vllm'],
    ['validate-vllm', '--mode', 'invalid'],
    ['validate-vllm', '--mode', 'controlled', '--plan', 'missing-plan.json'],
    ['validate-generator'],
    ['calibrate', '--config', 'examples/inferencegate.json'],
    ['compare', '--config', 'examples/inferencegate.json', '--lock', 'missing-lock.json'],
  ])('returns exit code 2 for invalid arguments: %j', async (...args) => {
    const result = await launch(args).done;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR:');
    expect(result.stderr).not.toContain('at main');
  });

  it('starts both endpoints and applies the candidate scenario', async () => {
    const process = launch(['mock-pair', '--baseline-port', '0', '--candidate-port', '0', '--candidate-scenario', 'errors']);
    await expect.poll(process.output, { timeout: 5000 }).toContain('Candidate (errors):');
    const urls = process.output().match(/http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/g);
    expect(urls).toHaveLength(2);
    expect(urls![0]).not.toBe(urls![1]);
    for (const endpoint of urls!) {
      const response = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(3000) });
      expect(await response.json()).toEqual({ status: 'ok', model: 'mock-model' });
    }
  });

  it('honors standalone flags on the wire', async () => {
    const process = launch(['mock', '--port', '0', '--error-rate', '1', '--error-status', '429']);
    await expect.poll(process.output, { timeout: 5000 }).toContain('Mock (healthy):');
    const endpoint = process.output().match(/http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/)![0];
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'Hello' }], stream: true }),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(429);
    await response.text();
  });
});
