import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseInput } from '../config.js';

const delay = z.number().int().min(0).max(2_147_483_647);

export const mockSettingsSchema = z.strictObject({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8001),
  model: z.string().trim().min(1).default('mock-model'),
  firstTokenDelayMs: delay.default(100),
  tokenDelayMs: delay.default(5),
  outputTokens: z.number().int().min(1).max(100_000).default(20),
  errorRate: z.number().min(0).max(1).default(0),
  errorStatus: z.number().int().min(400).max(599).default(503),
  disconnectAfterTokens: z.number().int().min(1).nullable().default(null),
  stall: z.boolean().default(false),
  omitUsage: z.boolean().default(false),
  seed: z.number().int().min(0).max(0xffff_ffff).default(42),
}).superRefine((settings, context) => {
  if (settings.disconnectAfterTokens !== null && settings.disconnectAfterTokens > settings.outputTokens) {
    context.addIssue({ code: 'custom', path: ['disconnectAfterTokens'], message: 'Must not exceed outputTokens' });
  }
});

export type MockSettings = z.infer<typeof mockSettingsSchema>;
export type MockOptions = z.input<typeof mockSettingsSchema>;

export const scenarios = {
  healthy: {},
  'slow-first-token': { firstTokenDelayMs: 300 },
  'slow-generation': { tokenDelayMs: 30 },
  errors: { errorRate: 0.2 },
  disconnect: { disconnectAfterTokens: 3 },
  timeout: { stall: true },
  'missing-usage': { omitUsage: true },
} satisfies Record<string, MockOptions>;

export type Scenario = keyof typeof scenarios;

export function resolveMockSettings(scenario: string, overrides: MockOptions = {}): MockSettings {
  if (!Object.hasOwn(scenarios, scenario)) {
    throw new Error(`Unknown scenario "${scenario}". Choose: ${Object.keys(scenarios).join(', ')}`);
  }
  return parseInput(mockSettingsSchema, { ...scenarios[scenario as Scenario], ...overrides }, 'Mock settings');
}

/** Stable across request ordering, concurrent connections, and process restarts. */
export function shouldFail(seed: number, requestId: string, errorRate: number): boolean {
  const hash = createHash('sha256').update(`${seed}\0${requestId}`).digest();
  const fraction = hash.readUInt32BE(0) / 0x1_0000_0000;
  return fraction < errorRate;
}
