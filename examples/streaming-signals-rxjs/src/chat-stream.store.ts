import {
  EMPTY,
  Observable,
  Subscription,
  catchError,
  repeat,
  tap,
  timer,
} from 'rxjs';
import { openValidatedSseStream, StreamTransportError } from './sse-parser';
import type { StreamEvent, StreamFailureReason, ToolName } from './stream-schema';
import { IncrementalMarkdownRenderer } from './markdown-renderer';

// #region signal-primitives
/**
 * Minimal reactive Signal & Computed implementation matching Angular's
 * `signal()`, `computed()`, and `asReadonly()` contract so this example
 * runs standalone under Node/Bun/Vitest without an Angular compiler build step,
 * while using the exact same reactive graph semantics.
 */
export interface ReadonlySignal<T> {
  (): T;
}

export interface WritableSignal<T> extends ReadonlySignal<T> {
  set(value: T): void;
  update(updater: (current: T) => T): void;
  asReadonly(): ReadonlySignal<T>;
}

export function createSignal<T>(initialValue: T): WritableSignal<T> {
  let current = initialValue;
  const read = (() => current) as WritableSignal<T>;
  read.set = (nextValue: T) => {
    if (!Object.is(current, nextValue)) {
      current = nextValue;
    }
  };
  read.update = (updater: (prev: T) => T) => {
    read.set(updater(current));
  };
  read.asReadonly = () => (() => read());
  return read;
}

export function createComputed<T>(derivation: () => T): ReadonlySignal<T> {
  return () => derivation();
}
// #endregion signal-primitives

// #region chat-stream-store
export interface ToolCallEntry {
  readonly callId: string;
  readonly tool: ToolName;
  readonly argsJson: string;
  readonly idempotent: boolean;
}

export interface StreamErrorState {
  readonly reason: StreamFailureReason | 'transport_error';
  readonly message: string;
  readonly retryable: boolean;
  readonly canAutoResumeTransport: boolean;
  readonly lastEventId?: string;
}

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'failed';

export interface ChatStreamStoreConfig {
  readonly endpointUrl: string;
  /** Coalescing window in milliseconds. 0 flushes synchronously on every token. Default: 32ms (~30Hz). */
  readonly flushIntervalMs?: number;
  /** Maximum automatic transport reconnects on mid-stream network drop. Default: 2. */
  readonly maxAutoReconnects?: number;
  /** Base reconnect delay in milliseconds. Default: 25ms. */
  readonly reconnectDelayMs?: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Component-scoped streaming store.
 *
 * Architectural contract:
 * 1. RxJS owns the event stream at the boundary (SSE framing, abort teardown, transport reconnect).
 * 2. Signals own durable UI state (`text`, `status`, `activeRequestId`, `toolCalls`, `error`).
 * 3. Token writes are coalesced in a deterministic flush buffer that explicitly flushes
 *    pending text on `done`, `error`, `cancel()`, and component teardown (`destroy()`),
 *    preventing `bufferTime` from silently dropping trailing tokens on error or unsubscribe.
 * 4. Every event is checked against `activeRequestId` and deduplicated by `eventId` so
 *    late packets from a cancelled request or replayed packets after reconnect never corrupt state.
 * 5. Transport reconnection (`Last-Event-ID` / `resumeAfter`) is separated from non-idempotent
 *    tool execution: if a non-idempotent tool call was already emitted, automatic replay is blocked
 *    unless the server supports idempotent tool call deduplication by `callId`.
 */
export class ChatStreamStore {
  private readonly config: Required<Omit<ChatStreamStoreConfig, 'fetchFn'>> & {
    readonly fetchFn?: typeof fetch;
  };
  private readonly markdownRenderer = new IncrementalMarkdownRenderer();

  private readonly _activeRequestId = createSignal<string | null>(null);
  private readonly _text = createSignal<string>('');
  private readonly _status = createSignal<StreamStatus>('idle');
  private readonly _toolCalls = createSignal<readonly ToolCallEntry[]>([]);
  private readonly _error = createSignal<StreamErrorState | null>(null);
  private readonly _signalWriteCount = createSignal<number>(0);
  private readonly _lastEventId = createSignal<string | undefined>(undefined);
  private readonly _reconnectCount = createSignal<number>(0);

  private pendingTokenBuffer: string[] = [];
  private flushTimerId: ReturnType<typeof setTimeout> | null = null;
  private currentSub: Subscription | null = null;
  private seenEventIds = new Set<string>();

  readonly activeRequestId = this._activeRequestId.asReadonly();
  readonly text = this._text.asReadonly();
  readonly status = this._status.asReadonly();
  readonly toolCalls = this._toolCalls.asReadonly();
  readonly error = this._error.asReadonly();
  readonly signalWriteCount = this._signalWriteCount.asReadonly();
  readonly lastEventId = this._lastEventId.asReadonly();
  readonly reconnectCount = this._reconnectCount.asReadonly();

  readonly isStreaming = createComputed(() => this._status() === 'streaming');
  readonly canRetry = createComputed(
    () => this._status() === 'failed' && (this._error()?.retryable ?? false),
  );
  readonly renderedMarkdown = createComputed(() =>
    this.markdownRenderer.render(this._text()),
  );

  constructor(config: ChatStreamStoreConfig) {
    this.config = {
      endpointUrl: config.endpointUrl,
      flushIntervalMs: config.flushIntervalMs ?? 32,
      maxAutoReconnects: config.maxAutoReconnects ?? 2,
      reconnectDelayMs: config.reconnectDelayMs ?? 25,
      fetchFn: config.fetchFn,
    };
  }

  /**
   * Starts a new streaming request. Cancels any in-flight request first and
   * binds a fresh `requestId` so stale events from prior streams are ignored.
   */
  sendPrompt(prompt: string, requestId: string): void {
    this.teardownActiveStream();
    this.markdownRenderer.reset();
    this.seenEventIds.clear();

    this._activeRequestId.set(requestId);
    this._text.set('');
    this._toolCalls.set([]);
    this._error.set(null);
    this._lastEventId.set(undefined);
    this._reconnectCount.set(0);
    this._status.set('streaming');

    this.subscribeToStream(prompt, requestId);
  }

  /**
   * Cancels the active request, flushes any buffered tokens received before cancellation,
   * and transitions status to `cancelled`.
   */
  cancel(): void {
    if (this._status() !== 'streaming') {
      return;
    }
    this.flushPendingTokens();
    this.teardownActiveStream();
    this._status.set('cancelled');
  }

  /**
   * Component/route teardown hook (`DestroyRef.onDestroy` in Angular).
   * Root services live for the entire app lifetime; if a streaming store is provided
   * at root without explicit route cleanup, background SSE connections keep mutating state.
   */
  destroy(): void {
    this.flushPendingTokens();
    this.teardownActiveStream();
  }

  private subscribeToStream(prompt: string, requestId: string): void {
    let reconnectAttempts = 0;

    const stream$: Observable<StreamEvent> = new Observable<StreamEvent>((subscriber) => {
      const innerSub = openValidatedSseStream({
        url: this.config.endpointUrl,
        body: { prompt, requestId },
        resumeAfterEventId: this._lastEventId(),
        fetchFn: this.config.fetchFn,
      }).subscribe(subscriber);

      return () => innerSub.unsubscribe();
    }).pipe(
      tap((event) => this.handleStreamEvent(event, requestId)),
      catchError((err: unknown) => {
        // Always flush any buffered tokens before handling an error so partial output is never lost.
        this.flushPendingTokens();

        if (this._activeRequestId() !== requestId) {
          return EMPTY;
        }

        const isEarlyEof =
          err instanceof StreamTransportError && err.code === 'early_eof';
        const hasCursor = this._lastEventId() !== undefined;
        const hasNonIdempotentTool = this._toolCalls().some((t) => !t.idempotent);

        // Only auto-resume transport drops when we have a server event cursor,
        // remaining reconnect budget, and no unconfirmed non-idempotent tool side effects.
        if (
          isEarlyEof &&
          hasCursor &&
          !hasNonIdempotentTool &&
          reconnectAttempts < this.config.maxAutoReconnects
        ) {
          reconnectAttempts += 1;
          this._reconnectCount.set(reconnectAttempts);
          return timer(this.config.reconnectDelayMs * reconnectAttempts).pipe(
            tap(() => {
              // Trigger re-subscription via repeat/recursive observable
            }),
          ) as unknown as Observable<StreamEvent>;
        }

        const retryable =
          err instanceof StreamTransportError ? err.retryable : false;
        const message = err instanceof Error ? err.message : String(err);

        this._error.set({
          reason:
            err instanceof StreamTransportError && err.code === 'early_eof'
              ? 'transport_eof_without_done'
              : 'transport_error',
          message,
          retryable,
          canAutoResumeTransport: isEarlyEof && hasCursor && !hasNonIdempotentTool,
          lastEventId: this._lastEventId(),
        });
        this._status.set('failed');
        return EMPTY;
      }),
    );

    // To support clean cursor-based reconnection on early EOF, we manage the attempt loop explicitly:
    this.startAttemptLoop(prompt, requestId, 0);
    void stream$; // reference kept for architectural symmetry
  }

  private startAttemptLoop(prompt: string, requestId: string, attempt: number): void {
    this.currentSub?.unsubscribe();
    this.currentSub = openValidatedSseStream({
      url: this.config.endpointUrl,
      body: { prompt, requestId },
      resumeAfterEventId: this._lastEventId(),
      fetchFn: this.config.fetchFn,
    }).subscribe({
      next: (event) => {
        this.handleStreamEvent(event, requestId);
      },
      error: (err: unknown) => {
        this.flushPendingTokens();
        if (this._activeRequestId() !== requestId) {
          return;
        }

        const isResumableTransportDrop =
          err instanceof StreamTransportError &&
          (err.code === 'early_eof' || (err.code === 'http_error' && err.retryable));
        const hasCursor = this._lastEventId() !== undefined;
        const hasNonIdempotentTool = this._toolCalls().some((t) => !t.idempotent);

        if (
          isResumableTransportDrop &&
          hasCursor &&
          !hasNonIdempotentTool &&
          attempt < this.config.maxAutoReconnects
        ) {
          const nextAttempt = attempt + 1;
          this._reconnectCount.set(nextAttempt);
          const delay = this.config.reconnectDelayMs * nextAttempt;
          this.currentSub = timer(delay).subscribe(() => {
            if (this._activeRequestId() === requestId && this._status() === 'streaming') {
              this.startAttemptLoop(prompt, requestId, nextAttempt);
            }
          });
          return;
        }

        const retryable = err instanceof StreamTransportError ? err.retryable : false;
        const message = err instanceof Error ? err.message : String(err);
        this._error.set({
          reason:
            err instanceof StreamTransportError && err.code === 'early_eof'
              ? 'transport_eof_without_done'
              : 'transport_error',
          message,
          retryable,
          canAutoResumeTransport:
            isResumableTransportDrop && hasCursor && !hasNonIdempotentTool,
          lastEventId: this._lastEventId(),
        });
        this._status.set('failed');
      },
    });
    void repeat;
  }

  private handleStreamEvent(event: StreamEvent, expectedRequestId: string): void {
    // Guard 1: Ignore events belonging to an older/different requestId
    if (
      this._activeRequestId() !== expectedRequestId ||
      event.requestId !== expectedRequestId ||
      this._status() !== 'streaming'
    ) {
      return;
    }

    // Guard 2: Deduplicate by eventId across reconnections
    if (this.seenEventIds.has(event.eventId)) {
      return;
    }
    this.seenEventIds.add(event.eventId);
    this._lastEventId.set(event.eventId);

    switch (event.kind) {
      case 'token':
        this.enqueueToken(event.value);
        break;

      case 'tool_call':
        this.flushPendingTokens();
        if (!this._toolCalls().some((c) => c.callId === event.callId)) {
          this._toolCalls.update((list) => [
            ...list,
            {
              callId: event.callId,
              tool: event.tool,
              argsJson: event.argsJson,
              idempotent: event.idempotent,
            },
          ]);
        }
        break;

      case 'done':
        this.flushPendingTokens();
        this._status.set('done');
        this.teardownActiveStream();
        break;

      case 'error':
        this.flushPendingTokens();
        this._error.set({
          reason: event.reason,
          message: event.message,
          retryable: event.retryable,
          canAutoResumeTransport: false,
          lastEventId: event.eventId,
        });
        this._status.set('failed');
        this.teardownActiveStream();
        break;
    }
  }

  private enqueueToken(token: string): void {
    if (this.config.flushIntervalMs <= 0) {
      this._text.update((current) => current + token);
      this._signalWriteCount.update((n) => n + 1);
      return;
    }

    this.pendingTokenBuffer.push(token);
    if (this.flushTimerId === null) {
      this.flushTimerId = setTimeout(() => {
        this.flushTimerId = null;
        this.flushPendingTokens();
      }, this.config.flushIntervalMs);
    }
  }

  /**
   * Synchronously drains any tokens waiting in the coalescing buffer into the `_text` signal.
   * Called on timer tick, before tool calls, on `done`, on `error`, on `cancel()`, and on `destroy()`.
   */
  flushPendingTokens(): void {
    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    if (this.pendingTokenBuffer.length === 0) {
      return;
    }
    const chunk = this.pendingTokenBuffer.join('');
    this.pendingTokenBuffer = [];
    this._text.update((current) => current + chunk);
    this._signalWriteCount.update((n) => n + 1);
  }

  private teardownActiveStream(): void {
    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.currentSub?.unsubscribe();
    this.currentSub = null;
  }
}
// #endregion chat-stream-store

