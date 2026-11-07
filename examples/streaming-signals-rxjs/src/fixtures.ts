import type { StreamEvent } from './stream-schema';

/**
 * Deterministic synthetic trace used across unit tests, the CLI demo, and the benchmark script.
 * Contains multi-paragraph Markdown, fenced TypeScript code, a table, and tool calls.
 */
export function buildSyntheticTrace(
  requestId = 'req-demo-001',
  tokenCount = 24,
): StreamEvent[] {
  const sampleTokens = [
    '### Streaming Architecture Summary\n\n',
    'When tokens arrive over **Server-Sent Events (SSE)** at 40 to 80 tokens per second, ',
    'writing every token straight into template state forces redundant markdown parsing ',
    'and DOM reconciliation inside a single 16.6ms display frame.\n\n',
    '```typescript\n',
    'export interface StreamCursor {\n',
    '  readonly requestId: string;\n',
    '  readonly lastEventId: string;\n',
    '}\n',
    '```\n\n',
    'By keeping **RxJS at the transport boundary** and coalescing writes into **Angular Signals** ',
    'every 32ms (~30Hz), we bound render work while keeping synchronous state reads.\n\n',
    '| Layer | Owner | Responsibility |\n',
    '| --- | --- | --- |\n',
    '| Transport | RxJS Observable | SSE framing, abort teardown, cursor reconnect |\n',
    '| UI State | Angular Signals | Synchronous template reads, derived flags |\n',
  ];

  const events: StreamEvent[] = [];
  for (let i = 0; i < tokenCount; i++) {
    const piece = sampleTokens[i % sampleTokens.length]!;
    events.push({
      kind: 'token',
      eventId: `evt-${String(i + 1).padStart(4, '0')}`,
      requestId,
      value: piece,
    });
  }

  events.push({
    kind: 'tool_call',
    eventId: `evt-${String(tokenCount + 1).padStart(4, '0')}`,
    requestId,
    callId: 'call-search-1',
    tool: 'search_docs',
    argsJson: JSON.stringify({ query: 'SSE Last-Event-ID replay buffer' }),
    idempotent: true,
  });

  events.push({
    kind: 'done',
    eventId: `evt-${String(tokenCount + 2).padStart(4, '0')}`,
    requestId,
    finishReason: 'stop',
  });

  return events;
}

