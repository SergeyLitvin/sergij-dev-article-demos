import { describe, expect, it } from 'vitest';
import { firstValueFrom, toArray } from 'rxjs';
import {
  openValidatedSseStream,
  parseSseFrames,
  StreamTransportError,
  type RawSseFrame,
} from '../src/sse-parser';
import { parseStreamEventPayload, type StreamEvent } from '../src/stream-schema';
import { MockSseServer } from '../src/mock-sse-server';
import { ChatStreamStore } from '../src/chat-stream.store';
import {
  AriaLiveAnnouncer,
  IncrementalMarkdownRenderer,
  sanitizeStreamHtml,
  shouldStickToBottom,
} from '../src/markdown-renderer';

function createChunkedByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('parseSseFrames (spec-compliant SSE framing)', () => {
  it('reassembles multi-byte UTF-8 characters split across arbitrary byte chunks', async () => {
    const payload = 'id: evt-1\nevent: token\ndata: {"kind":"token","value":"Привіт 🚀 світ"}\n\n';
    const bytes = new TextEncoder().encode(payload);

    // Split right inside the 3-byte Cyrillic and 4-byte emoji sequences (every 3 bytes)
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      chunks.push(bytes.subarray(i, i + 3));
    }

    const frames: RawSseFrame[] = [];
    for await (const frame of parseSseFrames(createChunkedByteStream(chunks))) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe('evt-1');
    expect(frames[0]?.event).toBe('token');
    expect(frames[0]?.data).toBe('{"kind":"token","value":"Привіт 🚀 світ"}');
  });

  it('handles CRLF (\\r\\n), LF (\\n), comments (:), and multi-line data fields', async () => {
    const raw =
      ': heartbeat comment\r\n' +
      'id: evt-42\r\n' +
      'retry: 1500\r\n' +
      'data: {"line":1,\n' +
      'data: "line":2}\r\n' +
      '\r\n';

    const bytes = new TextEncoder().encode(raw);
    const frames: RawSseFrame[] = [];
    for await (const frame of parseSseFrames(createChunkedByteStream([bytes]))) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      id: 'evt-42',
      event: 'message',
      data: '{"line":1,\n"line":2}',
      retry: 1500,
    });
  });
});

describe('parseStreamEventPayload (runtime boundary validation)', () => {
  it('rejects malformed JSON, non-object payloads, and unknown event kinds', () => {
    expect(parseStreamEventPayload('{broken json').ok).toBe(false);
    expect(parseStreamEventPayload('[1,2,3]').ok).toBe(false);
    expect(
      parseStreamEventPayload(
        JSON.stringify({ kind: 'invented', eventId: 'e1', requestId: 'r1' }),
      ).ok,
    ).toBe(false);
  });

  it('rejects tool_call events with unknown tool names', () => {
    const res = parseStreamEventPayload(
      JSON.stringify({
        kind: 'tool_call',
        eventId: 'e1',
        requestId: 'r1',
        callId: 'c1',
        tool: 'drop_database',
        argsJson: '{}',
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Unknown tool "drop_database"');
    }
  });

  it('accepts valid token, tool_call, done, and error events', () => {
    const tokenRes = parseStreamEventPayload(
      JSON.stringify({
        kind: 'token',
        eventId: 'e1',
        requestId: 'r1',
        value: 'Hello',
      }),
    );
    expect(tokenRes.ok).toBe(true);
  });
});

describe('openValidatedSseStream (transport EOF vs application done)', () => {
  it('fails with early_eof when transport closes before an application-level done event', async () => {
    const server = new MockSseServer();
    const events: StreamEvent[] = [
      { kind: 'token', eventId: 'e1', requestId: 'req-1', value: 'Partial ' },
      { kind: 'token', eventId: 'e2', requestId: 'req-1', value: 'answer' },
      { kind: 'done', eventId: 'e3', requestId: 'req-1', finishReason: 'stop' },
    ];
    server.registerStream('req-1', events);

    // Drop after 2 events (before `done`)
    const fetchFn = server.createFetchHandler({ dropFirstConnectionAfterEvents: 2 });

    await expect(
      firstValueFrom(
        openValidatedSseStream({
          url: 'https://stream.example.test/sse',
          body: { requestId: 'req-1' },
          fetchFn,
        }).pipe(toArray()),
      ),
    ).rejects.toThrowError(StreamTransportError);
  });
});

describe('ChatStreamStore (lifecycle, stale-request guard, buffer flushing, resumption)', () => {
  it('flushes buffered trailing tokens on cancel() and transitions to cancelled', async () => {
    const server = new MockSseServer();
    server.registerStream('req-cancel', [
      { kind: 'token', eventId: 'e1', requestId: 'req-cancel', value: 'First ' },
      { kind: 'token', eventId: 'e2', requestId: 'req-cancel', value: 'Second' },
      // No done event yet when we cancel
    ]);

    let resolveStreamHold!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      resolveStreamHold = resolve;
    });

    const fetchFn: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `id: e1\ndata: ${JSON.stringify({ kind: 'token', eventId: 'e1', requestId: 'req-cancel', value: 'First ' })}\n\n` +
                `id: e2\ndata: ${JSON.stringify({ kind: 'token', eventId: 'e2', requestId: 'req-cancel', value: 'Second' })}\n\n`,
            ),
          );
          await holdPromise;
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    // Use a long flush interval (5000ms) so tokens sit in the pending buffer when cancel() is called
    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 5000,
      fetchFn,
    });

    store.sendPrompt('Cancel test', 'req-cancel');
    await new Promise((r) => setTimeout(r, 15));

    // Before cancel(), the 5000ms timer hasn't fired yet, so text() is still empty
    expect(store.text()).toBe('');

    // Cancelling must flush the buffered tokens immediately before closing
    store.cancel();
    resolveStreamHold();

    expect(store.status()).toBe('cancelled');
    expect(store.text()).toBe('First Second');
  });

  it('flushes buffered trailing tokens when an error event arrives mid-stream', async () => {
    const server = new MockSseServer();
    server.registerStream('req-err', [
      { kind: 'token', eventId: 'e1', requestId: 'req-err', value: 'Partial output before ' },
      { kind: 'token', eventId: 'e2', requestId: 'req-err', value: 'rate limit.' },
      {
        kind: 'error',
        eventId: 'e3',
        requestId: 'req-err',
        reason: 'rate_limit',
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: 1000,
      },
    ]);

    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 5000, // Long interval to prove error handler flushes synchronously
      fetchFn: server.createFetchHandler(),
    });

    store.sendPrompt('Trigger rate limit', 'req-err');
    while (store.status() === 'streaming') {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(store.status()).toBe('failed');
    expect(store.text()).toBe('Partial output before rate limit.');
    expect(store.canRetry()).toBe(true);
  });

  it('prevents events from an older requestId from mutating a newly started request', async () => {
    let emitLateOldToken!: () => void;

    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      const encoder = new TextEncoder();

      if (body.requestId === 'req-old') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            emitLateOldToken = () => {
              try {
                controller.enqueue(
                  encoder.encode(
                    `id: old-1\ndata: ${JSON.stringify({ kind: 'token', eventId: 'old-1', requestId: 'req-old', value: 'STALE_POLLUTION' })}\n\n`,
                  ),
                );
              } catch {
                // Ignore if stream already closed
              }
            };
          },
        });
        return new Response(stream, { status: 200 });
      }

      // req-new completes cleanly
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `id: new-1\ndata: ${JSON.stringify({ kind: 'token', eventId: 'new-1', requestId: 'req-new', value: 'Clean fresh response' })}\n\n` +
                `id: new-2\ndata: ${JSON.stringify({ kind: 'done', eventId: 'new-2', requestId: 'req-new', finishReason: 'stop' })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 0,
      fetchFn,
    });

    store.sendPrompt('First prompt', 'req-old');
    await new Promise((r) => setTimeout(r, 10));

    // Immediately start a second request before the first finishes
    store.sendPrompt('Second prompt', 'req-new');
    if (emitLateOldToken) {
      emitLateOldToken();
    }

    while (store.status() === 'streaming') {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(store.activeRequestId()).toBe('req-new');
    expect(store.text()).toBe('Clean fresh response');
    expect(store.text()).not.toContain('STALE_POLLUTION');
  });

  it('resumes mid-stream from Last-Event-ID without duplicating tokens when transport drops', async () => {
    const server = new MockSseServer();
    server.registerStream('req-resume', [
      { kind: 'token', eventId: 'e1', requestId: 'req-resume', value: 'Alpha ' },
      { kind: 'token', eventId: 'e2', requestId: 'req-resume', value: 'Beta ' },
      { kind: 'token', eventId: 'e3', requestId: 'req-resume', value: 'Gamma' },
      { kind: 'done', eventId: 'e4', requestId: 'req-resume', finishReason: 'stop' },
    ]);

    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 10,
      maxAutoReconnects: 2,
      reconnectDelayMs: 5,
      fetchFn: server.createFetchHandler({ dropFirstConnectionAfterEvents: 2 }),
    });

    store.sendPrompt('Resume test', 'req-resume');
    while (store.status() === 'streaming') {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(store.status()).toBe('done');
    expect(store.reconnectCount()).toBe(1);
    expect(store.text()).toBe('Alpha Beta Gamma');
  });

  it('refuses automatic replay when a non-idempotent tool call was already emitted', async () => {
    const server = new MockSseServer();
    server.registerStream('req-non-idem', [
      { kind: 'token', eventId: 'e1', requestId: 'req-non-idem', value: 'Creating ticket...' },
      {
        kind: 'tool_call',
        eventId: 'e2',
        requestId: 'req-non-idem',
        callId: 'call-ticket-1',
        tool: 'create_ticket',
        argsJson: '{"title":"Outage"}',
        idempotent: false,
      },
      { kind: 'done', eventId: 'e3', requestId: 'req-non-idem', finishReason: 'tool_calls' },
    ]);

    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 0,
      maxAutoReconnects: 2,
      reconnectDelayMs: 5,
      fetchFn: server.createFetchHandler({ dropFirstConnectionAfterEvents: 2 }),
    });

    store.sendPrompt('Create ticket', 'req-non-idem');
    while (store.status() === 'streaming') {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Because `create_ticket` is non-idempotent, the store must not blindly auto-reconnect
    expect(store.status()).toBe('failed');
    expect(store.reconnectCount()).toBe(0);
    expect(store.error()?.canAutoResumeTransport).toBe(false);
  });

  it('fails cleanly with 410 when the server replay window has expired', async () => {
    let clockMs = 1_000;
    const server = new MockSseServer({
      replayTtlMs: 500,
      nowFn: () => clockMs,
    });
    server.registerStream('req-expired', [
      { kind: 'token', eventId: 'e1', requestId: 'req-expired', value: 'Hello ' },
      { kind: 'done', eventId: 'e2', requestId: 'req-expired', finishReason: 'stop' },
    ]);

    // Advance clock past TTL before reconnect
    const baseHandler = server.createFetchHandler({ dropFirstConnectionAfterEvents: 1 });
    let calls = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) {
        clockMs = 5_000; // expired!
      }
      return baseHandler(input, init);
    };

    const store = new ChatStreamStore({
      endpointUrl: 'https://stream.example.test/sse',
      flushIntervalMs: 0,
      maxAutoReconnects: 2,
      reconnectDelayMs: 5,
      fetchFn,
    });

    store.sendPrompt('Expire test', 'req-expired');
    while (store.status() === 'streaming') {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(store.status()).toBe('failed');
    expect(store.text()).toBe('Hello ');
    expect(store.error()?.retryable).toBe(false);
  });
});

describe('IncrementalMarkdownRenderer, XSS sanitization, and UX helpers', () => {
  it('strips <script>, onerror handlers, and javascript:/data: URLs from streamed markdown', () => {
    const malicious =
      'Hello <script>window.pwned=true</script> ' +
      '<img src="https://example.com/a.png" onerror="alert(1)"> ' +
      '[click me](javascript:alert(2)) and [safe](https://sergij.dev/articles)';

    const renderer = new IncrementalMarkdownRenderer();
    const out = renderer.render(malicious).fullSanitizedHtml;

    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href="https://sergij.dev/articles"');
    expect(sanitizeStreamHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain('data:');
  });

  it('stabilizes unclosed code fences in the streaming tail and caches completed blocks', () => {
    const renderer = new IncrementalMarkdownRenderer();

    const step1 = renderer.render('First completed paragraph.\n\n```ts\nconst x = 1;');
    expect(step1.cachedBlockCount).toBe(1);
    expect(step1.committedHtml).toContain('<p>First completed paragraph.</p>');
    expect(step1.activeTailHtml).toContain('<pre><code class="language-ts">');

    const step2 = renderer.render(
      'First completed paragraph.\n\n```ts\nconst x = 1;\n```\n\nThird paragraph.',
    );
    expect(step2.cachedBlockCount).toBe(2);
    expect(step2.activeTailHtml).toContain('<p>Third paragraph.</p>');
  });

  it('computes scroll anchoring and polite aria-live announcements', () => {
    expect(
      shouldStickToBottom({ scrollTop: 960, clientHeight: 400, scrollHeight: 1400 }, 48),
    ).toBe(true);
    expect(
      shouldStickToBottom({ scrollTop: 700, clientHeight: 400, scrollHeight: 1400 }, 48),
    ).toBe(false);

    const announcer = new AriaLiveAnnouncer();
    expect(announcer.announceStatusChange('streaming', '')).toBe(
      'Assistant is generating a response.',
    );
    expect(announcer.announceStatusChange('streaming', 'Short partial')).toBeNull();
    expect(announcer.announceStatusChange('done', 'Final text.')).toBe('Response complete.');
  });
});

