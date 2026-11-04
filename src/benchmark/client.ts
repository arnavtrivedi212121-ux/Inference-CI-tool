import type { BenchmarkConfig, Workload } from '../config.js';

export type FailureKind = 'http' | 'network' | 'timeout' | 'protocol' | 'cancelled' | 'schedule';
export interface RequestRecord {
  id: string;
  workloadId: string;
  success: boolean;
  ttftMs: number | null;
  latencyMs: number;
  completionTokens: number | null;
  finishReason: 'stop' | 'length' | null;
  completed: boolean;
  failure: { kind: FailureKind; message: string } | null;
}

class ProtocolError extends Error {}

/** SSE framing is independent of HTTP read boundaries and UTF-8 character boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // CR, LF and CRLF are valid SSE line endings. Hold a final CR until the next read.
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(pending)) !== null) {
        if (!done && match[0] === '\r' && match.index === pending.length - 1) break;
        const line = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        eventSize += line.length;
        if (eventSize > 1_048_576) throw new ProtocolError('SSE event exceeds 1 MiB');
        if (line === '') {
          if (data.length > 0) yield data.join('\n');
          data = [];
          eventSize = 0;
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line === 'data') {
          data.push('');
        }
      }
      if (pending.length + eventSize > 1_048_576) throw new ProtocolError('SSE event exceeds 1 MiB');
      if (done) break;
    }
    if (pending || data.length) throw new ProtocolError('Stream ended in an incomplete SSE event');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function measureRequest(
  endpoint: BenchmarkConfig['baseline'],
  request: Workload['requests'][number],
  id: string,
  timeoutMs: number,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<RequestRecord> {
  const started = performance.now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let ttftMs: number | null = null;
  let completionTokens: number | null = null;
  let finishReason: 'stop' | 'length' | null = null;
  let response: Response | undefined;
  let status: number | undefined;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        'x-inferencegate-request-id': id,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: endpoint.model, messages: request.messages, ...request.generation,
        stream: true, n: 1, stream_options: { include_usage: true } }),
    });
    if (!response.ok) { status = response.status; throw new Error(`HTTP ${status}`); }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      throw new ProtocolError('Expected a text/event-stream response');
    }
    let finished = false;
    let done = false;
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') { done = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw new ProtocolError('Invalid JSON in SSE data'); }
      if (!chunk || typeof chunk !== 'object' || chunk.error || !Array.isArray(chunk.choices)) {
        throw new ProtocolError('Invalid chat completion chunk');
      }
      if (chunk.usage != null) {
        const tokens: unknown = chunk.usage.completion_tokens;
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
          throw new ProtocolError('Invalid completion token usage');
        }
        completionTokens = tokens;
      }
      if (chunk.choices.length > 1) throw new ProtocolError('Expected one completion');
      for (const choice of chunk.choices) {
        if (choice?.index !== 0 || !choice.delta || typeof choice.delta !== 'object') {
          throw new ProtocolError('Invalid completion choice');
        }
        if (choice.delta.tool_calls || choice.delta.function_call) throw new ProtocolError('Only text completions are supported');
        if (choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.audio || choice.delta.refusal) {
          throw new ProtocolError('Reasoning, audio and refusal streams are unsupported; only generated text is measured');
        }
        const content: unknown = choice.delta.content;
        if (content != null && typeof content !== 'string') throw new ProtocolError('Invalid text delta');
        if (typeof content === 'string' && content.length > 0) {
          if (finished) throw new ProtocolError('Content arrived after completion');
          ttftMs ??= performance.now() - started;
        }
        if (choice.finish_reason != null) {
          if (!['stop', 'length'].includes(choice.finish_reason) || finished) throw new ProtocolError('Unsupported or repeated finish reason');
          finished = true;
          finishReason = choice.finish_reason;
        }
      }
    }
    if (!done || !finished || ttftMs === null) throw new ProtocolError('Stream lacks content, finish reason, or DONE');
    return { id, workloadId: request.id, success: true, ttftMs, latencyMs: performance.now() - started, completionTokens, finishReason, completed: true, failure: null };
  } catch (error) {
    const kind: FailureKind = signal?.aborted ? 'cancelled' : timeout.signal.aborted ? 'timeout'
      : status !== undefined ? 'http' : error instanceof ProtocolError || error instanceof SyntaxError || error instanceof TypeError && error.message.includes('encoded data') ? 'protocol' : 'network';
    const message = kind === 'http' ? `HTTP ${status}` : kind === 'protocol' ? (error as Error).message
      : kind === 'timeout' ? `Request exceeded ${timeoutMs} ms` : kind === 'cancelled' ? 'Run cancelled' : 'Connection failed or stream interrupted';
    return { id, workloadId: request.id, success: false, ttftMs, latencyMs: performance.now() - started, completionTokens: null, finishReason, completed: false, failure: { kind, message } };
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => {});
  }
}
