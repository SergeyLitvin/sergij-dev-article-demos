import os from 'node:os';
import { marked } from 'marked';
import {
  IncrementalMarkdownRenderer,
  sanitizeStreamHtml,
  stabilizeStreamingTail,
} from '../src/markdown-renderer';
import { createSignal } from '../src/chat-stream.store';

interface BenchmarkRow {
  readonly windowMs: number;
  readonly tokenCount: number;
  readonly signalWrites: number;
  readonly fullReRenderMs: number;
  readonly incrementalRenderMs: number;
}

/**
 * Deterministic benchmark comparing:
 * 1. Signal write frequency across batch windows (`0ms` unbatched, `16ms`, `32ms`, `50ms`, `100ms`)
 *    for a 600-token stream arriving at 2ms inter-token intervals (500 tokens/sec burst) or
 *    12.5ms intervals (80 tokens/sec steady stream).
 * 2. Full-transcript re-parse + sanitize (`O(N^2)`) vs bounded `IncrementalMarkdownRenderer`
 *    at each batch flush.
 */
function buildRealisticTokens(count: number): string[] {
  const paragraphTemplate = [
    '## Section ',
    '1',
    ': Streaming Backpressure\n\n',
    'When an SSE stream emits tokens faster than the display refresh rate, ',
    'updating the DOM on every token wastes CPU cycles on intermediate layouts ',
    'that the user never sees.\n\n',
    '```typescript\n',
    'const flushIntervalMs = 32;\n',
    'export function coalesceTokens(chunks: readonly string[]): string {\n',
    '  return chunks.join("");\n',
    '}\n',
    '```\n\n',
  ];

  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    const piece = paragraphTemplate[i % paragraphTemplate.length]!;
    tokens.push(
      piece === '1' ? String(Math.floor(i / paragraphTemplate.length) + 1) : piece,
    );
  }
  return tokens;
}

function runWindowSimulation(
  tokens: readonly string[],
  interTokenArrivalMs: number,
  windowMs: number,
): BenchmarkRow {
  const textSignal = createSignal('');
  let signalWrites = 0;

  // Determine which token indices trigger a flush under the given windowMs
  const flushSnapshots: string[] = [];
  let accumulated = '';
  let timeSinceLastFlush = 0;

  for (let i = 0; i < tokens.length; i++) {
    accumulated += tokens[i]!;
    timeSinceLastFlush += interTokenArrivalMs;

    if (windowMs === 0 || timeSinceLastFlush >= windowMs || i === tokens.length - 1) {
      textSignal.set(accumulated);
      signalWrites += 1;
      flushSnapshots.push(textSignal());
      timeSinceLastFlush = 0;
    }
  }

  // Measure Strategy A: Full markdown parse + sanitize on every signal write
  const t0Full = performance.now();
  let lastFullHtml = '';
  for (const snapshot of flushSnapshots) {
    const stabilized = stabilizeStreamingTail(snapshot);
    const raw = marked.parse(stabilized, { async: false }) as string;
    lastFullHtml = sanitizeStreamHtml(raw);
  }
  const fullReRenderMs = Number((performance.now() - t0Full).toFixed(2));

  // Measure Strategy B: Bounded IncrementalMarkdownRenderer on every signal write
  const incremental = new IncrementalMarkdownRenderer();
  const t0Inc = performance.now();
  let lastIncHtml = '';
  for (const snapshot of flushSnapshots) {
    lastIncHtml = incremental.render(snapshot).fullSanitizedHtml;
  }
  const incrementalRenderMs = Number((performance.now() - t0Inc).toFixed(2));

  if (!lastFullHtml || !lastIncHtml) {
    throw new Error('Unexpected empty render output during benchmark');
  }

  return {
    windowMs,
    tokenCount: tokens.length,
    signalWrites,
    fullReRenderMs,
    incrementalRenderMs,
  };
}

const tokenCount = 600;
const interTokenArrivalMs = 8; // 125 tokens/sec stream (4.8s total stream duration)
const tokens = buildRealisticTokens(tokenCount);

// Warm up JIT before recording numbers
runWindowSimulation(tokens.slice(0, 60), interTokenArrivalMs, 16);

const windows = [0, 16, 32, 50, 100];
const results = windows.map((w) => runWindowSimulation(tokens, interTokenArrivalMs, w));

const report = {
  environment: {
    runtime: `Node/Bun (${process.version})`,
    platform: `${os.platform()} ${os.arch()} (${os.release()})`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    tokenCount,
    interTokenArrivalMs,
    simulatedStreamDurationMs: tokenCount * interTokenArrivalMs,
  },
  results,
};

console.log(JSON.stringify(report, null, 2));
