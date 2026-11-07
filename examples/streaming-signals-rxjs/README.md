# Streaming LLM Responses with RxJS and Signals

Runnable companion project for the article **"Angular Signals vs RxJS for Streaming LLM Responses"** (`/articles/signals-vs-rxjs`).

## Purpose

This project demonstrates a production-patterned boundary between **RxJS** (event stream transport, SSE framing, abort teardown, and cursor-based reconnection) and **Signals** (synchronous UI state, coalesced token writes, and derived view flags).

All fixtures are synthetic and deterministic. No API keys or external network requests are required to run the demo, unit tests, or benchmark.

## Prerequisites

- **Bun**: `>= 1.3.0` (verified on `Bun 1.3.11`)
- **Node.js**: `>= 20.0.0` (if running `tsc` or `vitest` via Node)

## Commands

```bash
# Install dependencies (standalone lockfile)
bun install

# Typecheck with strict TypeScript
bun run typecheck

# Run the Vitest test suite (SSE framing, boundary validation, buffer flushing, resumption, XSS sanitization)
bun test

# Run the deterministic CLI streaming demo (includes simulated mid-stream drop + Last-Event-ID resume)
bun run demo

# Run the signal-write & incremental markdown benchmark
bun run benchmark
```

## Architecture & What Is Tested

1. **Spec-compliant SSE Parser (`src/sse-parser.ts`)**:
   - Uses `TextDecoderStream` so multi-byte UTF-8 characters split across arbitrary byte chunks never corrupt into `U+FFFD`.
   - Handles `\r\n`, `\n`, and `\r` line endings, `:` heartbeat comments, multi-line `data:` frames, `id:`, `event:`, and `retry:`.
   - Distinguishes application-level `done` events from transport EOF (`early_eof`).
2. **Runtime Boundary Validation (`src/stream-schema.ts`)**:
   - Validates parsed JSON into the `StreamEvent` discriminated union (`token`, `tool_call`, `done`, `error`) without unchecked `as StreamEvent` casts.
3. **Coalesced Signal Store (`src/chat-stream.store.ts`)**:
   - Tracks `activeRequestId` and deduplicates `eventId` so late packets from a stopped request cannot pollute a new prompt.
   - Explicitly flushes pending tokens on `done`, `error`, `cancel()`, and `destroy()` (avoiding the RxJS `bufferTime` pitfall where buffered items are dropped on error or unsubscription).
   - Separates transport retry (`Last-Event-ID` / `resumeAfter`) from non-idempotent tool calls (`idempotent: false`).
4. **Server Replay Contract (`src/mock-sse-server.ts`)**:
   - Implements a bounded replay buffer with TTL expiry (`410 Gone` when expired) so mid-stream resumption is backed by an explicit server contract.
5. **Bounded Markdown Rendering & Sanitization (`src/markdown-renderer.ts`)**:
   - Caches completed Markdown blocks and only re-parses the active tail (`stabilizeStreamingTail`), sanitizing HTML via `sanitize-html` with strict link-scheme allowlisting (`https:`, `mailto:`, relative paths).

## Limitations

- This package uses a lightweight signal primitive (`createSignal` / `createComputed` in `src/chat-stream.store.ts`) with the exact same synchronous read/write contract as `@angular/core` `signal()` and `computed()`, so the tests and benchmark execute directly in Node/Bun without requiring a full browser DOM or Angular compiler pipeline.
- The benchmark (`scripts/benchmark.ts`) measures JavaScript signal write frequency and Markdown parse + HTML sanitization time in Bun; actual browser layout/paint times depend on the host DOM tree and CSS complexity.

