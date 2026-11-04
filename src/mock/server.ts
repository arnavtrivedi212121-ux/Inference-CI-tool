import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { messageSchema, parseInput } from '../config.js';
import { mockSettingsSchema, shouldFail, type MockOptions } from './settings.js';

const MAX_BODY_BYTES = 1024 * 1024;
const requestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.literal(true),
  n: z.literal(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
  seed: z.number().int().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
}).refine((value) => value.max_tokens === undefined || value.max_completion_tokens === undefined,
  'Use either max_tokens or max_completion_tokens, not both');

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function errorResponse(response: ServerResponse, status: number, message: string) {
  json(response, status, { error: { message, type: 'mock_error', code: status } });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    request.resume();
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new HttpError(413, 'Request body exceeds 1 MiB'));
      } else {
        chunks.push(chunk);
      }
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('Client disconnected while sending request')));
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function writeEvent(response: ServerResponse, data: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  if (!response.write(`data: ${payload}\n\n`)) {
    await once(response, 'drain', { signal });
  }
}

/** Start a local HTTP fixture. Port 0 lets tests choose an available port. */
export async function startMockServer(options: MockOptions = {}) {
  const settings = parseInput(mockSettingsSchema, options, 'Mock settings');
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.once('close', () => {
      controller.abort();
      controllers.delete(controller);
    });
    void handle(request, response, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted || response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else {
        errorResponse(response, error instanceof HttpError ? error.status : 500,
          error instanceof HttpError ? error.message : 'Mock server request failed');
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  async function handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal) {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' || path === '/v1/models') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        throw new HttpError(405, 'Use GET for this endpoint');
      }
      json(response, 200, path === '/health'
        ? { status: 'ok', model: settings.model }
        : { object: 'list', data: [{ id: settings.model, object: 'model', created: 0, owned_by: 'inferencegate-mock' }] });
      return;
    }
    if (path !== '/v1/chat/completions') throw new HttpError(404, 'Unknown endpoint');
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      throw new HttpError(405, 'Use POST for chat completions');
    }
    const parsed = requestSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) =>
        `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '));
    }
    const body = parsed.data;
    if (body.model !== settings.model) throw new HttpError(404, `Model "${body.model}" is not served by this mock`);
    const headerId = request.headers['x-inferencegate-request-id'];
    // Fallback is stable for an identical body. Callers should give repetitions distinct IDs.
    const requestId = typeof headerId === 'string' && headerId.length > 0
      ? headerId
      : createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const streamId = `chatcmpl-mock-${createHash('sha256').update(requestId).digest('hex').slice(0, 16)}`;
    response.setHeader('x-inferencegate-request-id', requestId);
    if (shouldFail(settings.seed, requestId, settings.errorRate)) {
      throw new HttpError(settings.errorStatus, `Injected HTTP failure for request ${requestId}`);
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    request.socket.setNoDelay(true);
    const created = Math.floor(Date.now() / 1000);
    const chunk = (choices: unknown[], usage?: unknown) => ({
      id: streamId, object: 'chat.completion.chunk', created, model: settings.model, choices,
      ...(body.stream_options?.include_usage ? { usage: usage ?? null } : {}),
    });
    await writeEvent(response, chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]), signal);
    if (settings.stall) {
      // End only when the client cancels or the server shuts down; no interval or open timer.
      signal.throwIfAborted();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    await delay(settings.firstTokenDelayMs, undefined, { signal });
    const requestedLimit = body.max_tokens ?? body.max_completion_tokens;
    const outputTokens = Math.min(settings.outputTokens, requestedLimit ?? settings.outputTokens);
    for (let index = 0; index < outputTokens; index++) {
      if (index > 0) await delay(settings.tokenDelayMs, undefined, { signal });
      await writeEvent(response, chunk([{
        index: 0,
        delta: { content: index === 0 ? 'Mock' : ' token' },
        finish_reason: null,
      }]), signal);
      if (settings.disconnectAfterTokens === index + 1) {
        response.destroy();
        return;
      }
    }
    await writeEvent(response, chunk([{
      index: 0, delta: {},
      finish_reason: requestedLimit !== undefined && requestedLimit <= settings.outputTokens ? 'length' : 'stop',
    }]), signal);
    if (body.stream_options?.include_usage && !settings.omitUsage) {
      // Synthetic accounting for fixtures; this is not a model tokenizer.
      const promptTokens = body.messages.reduce((total, message) =>
        total + Math.max(1, message.content.trim().split(/\s+/).length), 0);
      await writeEvent(response, chunk([], {
        prompt_tokens: promptTokens, completion_tokens: outputTokens, total_tokens: promptTokens + outputTokens,
      }), signal);
    }
    await writeEvent(response, '[DONE]', signal);
    response.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock did not obtain a TCP address');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return {
    url,
    endpoint: `${url}/v1/chat/completions`,
    settings,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

export type MockServer = Awaited<ReturnType<typeof startMockServer>>;
