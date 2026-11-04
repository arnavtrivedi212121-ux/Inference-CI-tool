import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const percent = z.number().min(0).max(100);

export const messageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

export const generationSchema = z.strictObject({
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: positiveInteger.max(1_000_000).default(128),
});

export const workloadSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(z.strictObject({
    id: nonEmpty,
    messages: z.array(messageSchema).min(1),
    generation: generationSchema.default({ temperature: 0, max_tokens: 128 }),
  })).min(1).superRefine((requests, context) => {
    const seen = new Set<string>();
    requests.forEach((request, index) => {
      if (seen.has(request.id)) {
        context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Request IDs must be unique' });
      }
      seen.add(request.id);
    });
  }),
});

const endpointSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password && !url.hash;
  }, 'Endpoint URLs must not contain credentials or fragments'),
  model: nonEmpty,
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  deployment: z.strictObject({
    id: nonEmpty, runtimeVersion: nonEmpty, modelRevision: nonEmpty, tokenizerId: nonEmpty,
    hardware: nonEmpty, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  }).optional(),
});

export const configSchema = z.strictObject({
  version: z.literal(2),
  baseline: endpointSchema,
  candidate: endpointSchema,
  workload: nonEmpty,
  run: z.strictObject({
    concurrency: positiveInteger.max(10_000),
    warmupRequests: z.number().int().nonnegative(),
    repetitions: positiveInteger,
    timeoutMs: positiveInteger.max(2_147_483_647),
    seed: z.number().int().min(0).max(0xffff_ffff),
    trials: z.number().int().min(3).max(10).default(5),
    cooldownMs: z.number().int().min(0).max(60_000).default(1000),
    arrivalIntervalMs: positiveInteger.max(60_000).default(100),
    maxArrivalLagMs: positiveInteger.max(5000).default(50),
  }),
  thresholds: z.strictObject({
    ttftP95MaxIncreasePercent: z.number().nonnegative(),
    latencyP95MaxIncreasePercent: z.number().nonnegative(),
    throughputMaxDecreasePercent: percent,
    errorRateMaxIncreasePercentagePoints: percent,
    candidateMaxErrorRatePercent: percent,
  }),
  baselineValidity: z.strictObject({
    maxErrorRatePercent: percent,
    minSuccessfulRequests: positiveInteger.min(100),
  }).default({ maxErrorRatePercent: 1, minSuccessfulRequests: 100 }),
  comparability: z.strictObject({
    maxOutputTokenDifferencePercent: percent,
  }).default({ maxOutputTokenDifferencePercent: 10 }),
  outputDir: nonEmpty,
});

export type BenchmarkConfig = z.infer<typeof configSchema>;
export type Workload = z.infer<typeof workloadSchema>;

export function redactEndpoint(endpoint: BenchmarkConfig['baseline']) {
  const url = new URL(endpoint.url);
  for (const name of new Set(url.searchParams.keys())) url.searchParams.set(name, '[REDACTED]');
  return { ...endpoint, url: url.toString() };
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new Error(`${label} is invalid:\n${details}`);
  }
  return result.data;
}

export async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? 'read error'}`);
  }
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

export async function loadBenchmarkConfig(path: string) {
  const configPath = resolve(path);
  const input = await readJson(configPath);
  if (input && typeof input === 'object' && 'version' in input && input.version === 1) {
    throw new Error('Config v1 is unsupported. Set version to 2 and use at least 100 requests per phase. See examples/inferencegate.json for a working config. Workloads remain v1.');
  }
  const config = parseInput(configSchema, input, 'Configuration');
  const workloadPath = resolve(dirname(configPath), config.workload);
  const workload = parseInput(workloadSchema, await readJson(workloadPath), 'Workload');
  const measuredRequests = workload.requests.length * config.run.repetitions;
  if (!Number.isSafeInteger(measuredRequests)) {
    throw new Error('Measured request count must be a safe integer');
  }
  if (measuredRequests > 100_000 || measuredRequests * config.run.arrivalIntervalMs > 86_400_000) {
    throw new Error('A phase must have at most 100,000 requests and a planned duration of at most 24 hours');
  }
  if (measuredRequests < config.baselineValidity.minSuccessfulRequests) {
    throw new Error('Measured request count is smaller than baselineValidity.minSuccessfulRequests');
  }
  return {
    config,
    workload,
    configPath,
    workloadPath,
    outputDir: resolve(dirname(configPath), config.outputDir),
    measuredRequests,
  };
}
