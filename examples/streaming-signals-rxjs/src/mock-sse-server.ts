import type { StreamEvent } from './stream-schema';

// #region mock-sse-server
export interface ReplayEntry {
  readonly event: StreamEvent;
  readonly createdAtMs: number;
}

export interface MockServerSession {
  readonly requestId: string;
  readonly events: readonly ReplayEntry[];
  readonly expiresAtMs: number;
}

export interface MockSseServerOptions {
  readonly replayTtlMs?: number;
  readonly nowFn?: () => number;
}

/**
 * Deterministic in-memory SSE server with replay buffer and cursor semantics.
 *
 * Demonstrates what mid-stream resumption requires on the server:
 * 1. Stable `requestId` and monotonic `eventId` per frame
 * 2. Bounded replay buffer with explicit TTL (`replayTtlMs`)
 * 3. Cursor slicing (`resumeAfter` / `Last-Event-ID`): replays only events strictly after the cursor
 * 4. Explicit `410 Gone` fallback when the cursor has expired or is unknown, so the client
 *    knows it cannot silently stitch a partial response
 */
export class MockSseServer {
  private readonly sessions = new Map<string, MockServerSession>();
  private readonly replayTtlMs: number;
  private readonly now: () => number;

  constructor(options: MockSseServerOptions = {}) {
    this.replayTtlMs = options.replayTtlMs ?? 60_000;
    this.now = options.nowFn ?? (() => Date.now());
  }

  registerStream(requestId: string, events: readonly StreamEvent[]): void {
    const timestamp = this.now();
    this.sessions.set(requestId, {
      requestId,
      events: events.map((event) => ({ event, createdAtMs: timestamp })),
      expiresAtMs: timestamp + this.replayTtlMs,
    });
  }

  /**
   * Creates a fetch-compatible handler supporting simulated network drops (`dropAfterIndex`)
   * and mid-stream resumption (`resumeAfter` body field or `Last-Event-ID` header).
   */
  createFetchHandler(options: {
    /** Drop the first connection after emitting this many events (simulates mid-stream disconnect). */
    dropFirstConnectionAfterEvents?: number;
    /** Optional byte chunk size to test arbitrary UTF-8 and frame boundaries. */
    chunkByteSize?: number;
  } = {}): typeof fetch {
    let connectionAttempts = 0;

    return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      connectionAttempts += 1;
      const bodyObj = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const requestId = String(bodyObj['requestId'] ?? '');
      const headers = new Headers(init?.headers);
      const resumeAfter =
        (typeof bodyObj['resumeAfter'] === 'string' ? bodyObj['resumeAfter'] : undefined) ??
        headers.get('Last-Event-ID') ??
        undefined;

      const session = this.sessions.get(requestId);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unknown requestId' }), { status: 404 });
      }

      if (this.now() > session.expiresAtMs) {
        this.sessions.delete(requestId);
        return new Response(
          JSON.stringify({ error: 'Replay window expired; start a new request' }),
          { status: 410 },
        );
      }

      let startIndex = 0;
      if (resumeAfter !== undefined) {
        const cursorIdx = session.events.findIndex((e) => e.event.eventId === resumeAfter);
        if (cursorIdx === -1) {
          return new Response(
            JSON.stringify({ error: `Unknown cursor eventId "${resumeAfter}"` }),
            { status: 410 },
          );
        }
        startIndex = cursorIdx + 1;
      }

      const slice = session.events.slice(startIndex);
      const dropLimit =
        connectionAttempts === 1 && options.dropFirstConnectionAfterEvents !== undefined
          ? options.dropFirstConnectionAfterEvents
          : slice.length;

      const eventsToSend = slice.slice(0, dropLimit);
      const encoder = new TextEncoder();

      const rawSseString = eventsToSend
        .map(
          ({ event }) =>
            `id: ${event.eventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join('');

      const allBytes = encoder.encode(rawSseString);
      const chunkSize = options.chunkByteSize ?? allBytes.byteLength;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (allBytes.byteLength === 0) {
            controller.close();
            return;
          }
          for (let offset = 0; offset < allBytes.byteLength; offset += chunkSize) {
            controller.enqueue(allBytes.subarray(offset, offset + chunkSize));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    };
  }
}
// #endregion mock-sse-server

