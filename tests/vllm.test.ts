import { expect, it } from 'vitest';
import { assertActive, assertReleased, parseGpu, serverArgs, VLLM_IMAGE, REVISION } from '../src/validation/vllm.js';

const csv = 'GPU-test, NVIDIA RTX 3060, 610.62, 500, 12288, 0, 45';
it('fails closed on missing GPU telemetry, active compute, busy GPU and unreleased memory', () => {
  const idle = parseGpu(csv, '');
  expect(() => assertReleased(idle, idle)).not.toThrow();
  for (const bad of ['GPU-test, GPU, driver, N/A, 12288, 0, 45', 'GPU-test, GPU, driver, , 12288, 0, 45', '']) expect(() => parseGpu(bad, '')).toThrow('telemetry');
  expect(() => parseGpu(csv, '[Not Supported]')).toThrow('telemetry');
  for (const current of [{ ...idle, computePids: [12] }, { ...idle, memoryUsedMiB: 800 }, { ...idle, utilizationPercent: 50 }, { ...idle, uuid: 'different' }, { ...idle, driver: 'changed' }]) {
    expect(() => assertReleased(idle, current)).toThrow('GPU is busy');
  }
});
it('rejects foreign or unobservable GPU processes during a controlled phase', () => {
  const idle = parseGpu(csv, ''), active = { ...idle, computePids: [123], utilizationPercent: 90 };
  expect(() => assertActive(idle, active, [120, 123])).not.toThrow();
  for (const current of [{ ...active, computePids: [] }, { ...active, computePids: [123, 999] }, { ...active, uuid: 'other' }, { ...active, driver: 'changed' }]) expect(() => assertActive(idle, current, [123])).toThrow('ownership');
  for (const pids of [[], [NaN], [0]]) expect(() => assertActive(idle, active, pids)).toThrow('ownership');
});
it('pins image, model and tokenizer revision and separates resident memory budgets', () => {
  const args = serverArgs('test-name', '0', 18001, 8, false);
  expect(args).toContain(VLLM_IMAGE); expect(args.filter(value => value === REVISION)).toHaveLength(2);
  expect(args).toContain('127.0.0.1:18001:8000'); expect(args).toContain('0.70');
  expect(serverArgs('test-name', '0', 18002, 1, true)).toContain('0.35');
  expect(args).toContain('--no-enable-prefix-caching'); expect(args).not.toContain('--trust-remote-code');
});
