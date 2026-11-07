import { Observable } from 'rxjs';
import { parseStreamEventPayload, type StreamEvent } from './stream-schema';

// #region sse-parser
export interface RawSseFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
  readonly retry?: number;
}

export class StreamTransportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'http_error'
      | 'empty_body'
      | 'early_eof'
      | 'malformed_frame'
      | 'invalid_event_payload',
    readonly retryable: boolean,
    readonly lastEventId?: string,
  ) {
    super(message);
    this.name = 'StreamTransportError';
  }
}

/**
 * Spec-compliant SSE frame parser for WHATWG ReadableStream<Uint8Array>.
 *
 * Handles:
 * - Arbitrary byte-chunk boundaries and split multi-byte UTF-8 sequences (via TextDecoderStream)
 * - CRLF (\r\n), LF (\n), and CR (\r) line endings
 * - Comment heartbeats (`: keep-alive`)
 * - Multi-line `data:` fields joined with `\n`
 * - `id:`, `event:`, and `retry:` fields
 */
export async function* parseSseFrames(
  byteStream: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseFrame, void, unknown> {
  const textStream = byteStream.pipeThrough(
    new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>,
  );
  const reader = textStream.getReader();

  let buffer = '';
  let lastEventId: string | undefined;
  let eventType = 'message';
  let dataLines: string[] = [];
  let retryMs: number | undefined;

  const flushEvent = (): RawSseFrame | null => {
    if (dataLines.length === 0) {
      eventType = 'message';
      retryMs = undefined;
      return null;
    }
    const frame: RawSseFrame = {
      ...(lastEventId !== undefined ? { id: lastEventId } : {}),
      event: eventType,
      data: dataLines.join('\n'),
      ...(retryMs !== undefined ? { retry: retryMs } : {}),
    };
    eventType = 'message';
    dataLines = [];
    retryMs = undefined;
    return frame;
  };

  const processLine = (line: string): RawSseFrame | null => {
    if (line === '') {
      return flushEvent();
    }
    if (line.startsWith(':')) {
      return null; // Comment / heartbeat line
    }

    const colonIndex = line.indexOf(':');
    let field = line;
    let value = '';

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          lastEventId = value;
        }
        break;
      case 'retry': {
        if (/^\d+$/.test(value)) {
          retryMs = Number.parseInt(value, 10);
        }
        break;
      }
      default:
        // Unknown fields are ignored per WHATWG SSE specification
        break;
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;

      let lineEndIndex = findLineBreak(buffer);
      while (lineEndIndex !== -1) {
        const line = buffer.slice(0, lineEndIndex.index);
        buffer = buffer.slice(lineEndIndex.nextStart);
        const frame = processLine(line);
        if (frame !== null) {
          yield frame;
        }
        lineEndIndex = findLineBreak(buffer);
      }
    }

    // Per SSE spec, an unterminated trailing block without a blank line at EOF is discarded,
    // not dispatched. However, if a caller sent a trailing line with no final blank line,
    // our higher-level stream contract checks for an explicit application-level `done` event.
  } finally {
    reader.releaseLock();
  }
}

function findLineBreak(input: string): { index: number; nextStart: number } | -1 {
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\r') {
      if (input[i + 1] === '\n') {
        return { index: i, nextStart: i + 2 };
      }
      return { index: i, nextStart: i + 1 };
    }
    if (ch === '\n') {
      return { index: i, nextStart: i + 1 };
    }
  }
  return -1;
}

export interface OpenSseStreamOptions {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly resumeAfterEventId?: string;
  readonly fetchFn?: typeof fetch;
}

/**
 * Wraps a POST SSE stream in an RxJS Observable with:
 * - AbortController teardown on unsubscribe
 * - Runtime boundary validation (`parseStreamEventPayload`)
 * - Strict separation between application-level `done` and transport EOF
 */
export function openValidatedSseStream(
  options: OpenSseStreamOptions,
): Observable<StreamEvent> {
  const fetchImpl = options.fetchFn ?? fetch;

  return new Observable<StreamEvent>((subscriber) => {
    const controller = new AbortController();
    let sawTerminalEvent = false;
    let lastSeenEventId = options.resumeAfterEventId;

    (async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        if (options.resumeAfterEventId) {
          headers['Last-Event-ID'] = options.resumeAfterEventId;
        }

        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...options.body,
            ...(options.resumeAfterEventId
              ? { resumeAfter: options.resumeAfterEventId }
              : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
          subscriber.error(
            new StreamTransportError(
              `HTTP ${response.status} from stream endpoint`,
              'http_error',
              retryable,
              lastSeenEventId,
            ),
          );
          return;
        }

        if (!response.body) {
          subscriber.error(
            new StreamTransportError(
              'Response body is empty',
              'empty_body',
              false,
              lastSeenEventId,
            ),
          );
          return;
        }

        for await (const frame of parseSseFrames(response.body)) {
          if (controller.signal.aborted) {
            return;
          }

          const validation = parseStreamEventPayload(frame.data, frame.id);
          if (!validation.ok) {
            subscriber.error(
              new StreamTransportError(
                validation.error,
                'invalid_event_payload',
                false,
                lastSeenEventId,
              ),
            );
            return;
          }

          const event = validation.value;
          lastSeenEventId = event.eventId;
          subscriber.next(event);

          if (event.kind === 'done' || event.kind === 'error') {
            sawTerminalEvent = true;
            subscriber.complete();
            return;
          }
        }

        // If the byte stream ended without an application-level `done` or `error` frame,
        // the connection dropped mid-response. Never treat transport EOF as completion.
        if (!sawTerminalEvent && !controller.signal.aborted) {
          subscriber.error(
            new StreamTransportError(
              'Stream connection closed before receiving a terminal "done" event.',
              'early_eof',
              true,
              lastSeenEventId,
            ),
          );
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          subscriber.error(err);
        }
      }
    })();

    return () => controller.abort();
  });
}
// #endregion sse-parser
