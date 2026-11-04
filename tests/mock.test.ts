import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../src/mock/server.js';
import type { MockOptions } from '../src/mock/settings.js';

const servers: MockServer[] = [];
async function start(options: MockOptions = {}) {
  const server = await startMockServer({ port: 0, firstTokenDelayMs: 0, tokenDelayMs: 0, outputTokens: 4, ...options });
  servers.push(server);
  return server;
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

const requestBody = {
  model: 'mock-model', messages: [{ role: 'user', content: 'Hello world' }],
  stream: true, stream_options: { include_usage: true },
};
function send(server: MockServer, body: unknown = requestBody, id = 'request-1', signal?: AbortSignal) {
  return fetch(server.endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inferencegate-request-id': id },
    body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(5000),
  });
}
type Chunk = {
  id: string; object: string; model: string;
  choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
};
function events(text: string): Chunk[] {
  return text.split('\n\n').filter((event) => event.startsWith('data: ') && event !== 'data: [DONE]')
    .map((event) => JSON.parse(event.slice(6)) as Chunk);
}

describe('OpenAI-compatible mock over HTTP', () => {
  it('streams a role event, content, finish reason, final usage, and DONE in order', async () => {
    const server = await start();
    const response = await send(server);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-inferencegate-request-id')).toBe('request-1');
    const text = await response.text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    const chunks = events(text);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.filter((chunk) => chunk.choices[0]?.delta.content)).toHaveLength(4);
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 });
    expect(chunks.every((chunk) => chunk.model === 'mock-model' && chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
  });

  it.each(['max_tokens', 'max_completion_tokens'])('honors the %s output limit', async (field) => {
    const response = await send(await start(), { ...requestBody, [field]: 2 });
    const chunks = events(await response.text());
    expect(chunks.at(-1)?.usage?.completion_tokens).toBe(2);
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('length');
  });

  it('does not report usage unless requested, and can deliberately omit final usage', async () => {
    const normal = events(await (await send(await start(), { ...requestBody, stream_options: { include_usage: false } })).text());
    expect(normal.every((chunk) => !Object.hasOwn(chunk, 'usage'))).toBe(true);
    const missing = events(await (await send(await start({ omitUsage: true }))).text());
    expect(missing.every((chunk) => chunk.usage === null)).toBe(true);
    expect(missing.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('delays first content separately from role events and subsequent content', async () => {
    const server = await start({ firstTokenDelayMs: 150, tokenDelayMs: 60, outputTokens: 3 });
    const response = await send(server);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let roleAt: number | undefined;
    const contentAt: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event === 'data: [DONE]') continue;
        const chunk = JSON.parse(event.slice(6)) as Chunk;
        if (chunk.choices[0]?.delta.role) roleAt = performance.now();
        if (chunk.choices[0]?.delta.content) contentAt.push(performance.now());
      }
    }
    expect(roleAt).toBeDefined();
    expect(contentAt).toHaveLength(3);
    // Wide lower bounds verify actual streaming delays without exact wall-clock assertions.
    expect(contentAt[0]! - roleAt!).toBeGreaterThanOrEqual(100);
    expect(contentAt[2]! - contentAt[0]!).toBeGreaterThanOrEqual(80);
  });

  it('preserves injected failures across restarts and concurrent request ordering', async () => {
    const options = { seed: 42, errorRate: 0.5, outputTokens: 1 };
    const ids = Array.from({ length: 20 }, (_, index) => `sample-${index}`);
    const replay = async (server: MockServer, order: string[]) => {
      const records = await Promise.all(order.map(async (id) => {
        const response = await send(server, requestBody, id);
        await response.text();
        return [id, response.status] as const;
      }));
      return Object.fromEntries(records);
    };
    const first = await start(options);
    const result = await replay(first, ids);
    await first.close();
    const second = await start(options);
    expect(await replay(second, [...ids].reverse())).toEqual(result);
    expect(Object.values(result)).toContain(200);
    expect(Object.values(result)).toContain(503);
  });

  it('returns an OpenAI-style error body for deliberately failed requests', async () => {
    const response = await send(await start({ errorRate: 1, errorStatus: 429 }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { type: 'mock_error', code: 429 } });
  });

  it('breaks interrupted streams rather than emitting a successful completion', async () => {
    const response = await send(await start({ tokenDelayMs: 10, disconnectAfterTokens: 2 }));
    await expect(response.text()).rejects.toThrow();
  });

  it('allows a stalled request to be cancelled, then serves another request', async () => {
    const server = await start({ stall: true });
    const controller = new AbortController();
    const response = await send(server, requestBody, 'stalled', controller.signal);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('assistant');
    const pending = reader.read();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it('closes active stalled connections and can be closed twice', async () => {
    const server = await start({ stall: true });
    const response = await send(server);
    const body = response.text();
    const rejected = expect(body).rejects.toThrow();
    await server.close();
    await rejected;
    await server.close();
  });

  it('exposes health/models and rejects unsupported methods, routes, models, and bodies', async () => {
    const server = await start();
    expect(await (await fetch(`${server.url}/health`)).json()).toEqual({ status: 'ok', model: 'mock-model' });
    expect(await (await fetch(`${server.url}/v1/models`)).json()).toMatchObject({ data: [{ id: 'mock-model' }] });
    expect((await fetch(server.endpoint)).status).toBe(405);
    expect((await fetch(`${server.url}/missing`)).status).toBe(404);
    expect((await send(server, { ...requestBody, model: 'wrong' })).status).toBe(404);
    expect((await send(server, { ...requestBody, stream: false })).status).toBe(400);
    expect((await send(server, { ...requestBody, n: 2 })).status).toBe(400);
    expect((await fetch(server.endpoint, { method: 'POST', body: '{}' })).status).toBe(415);
    const malformed = await fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    expect(malformed.status).toBe(400);
    const oversized = await send(server, { ...requestBody, messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
    expect(oversized.status).toBe(413);
  });

  it('reports a port collision without leaving another listener open', async () => {
    const server = await start();
    await expect(startMockServer({ port: Number(new URL(server.url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
