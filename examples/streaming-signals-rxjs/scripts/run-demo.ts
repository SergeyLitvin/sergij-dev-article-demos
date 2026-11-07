import { ChatStreamStore } from '../src/chat-stream.store';
import { buildSyntheticTrace } from '../src/fixtures';
import { MockSseServer } from '../src/mock-sse-server';

async function main() {
  const requestId = 'req-demo-001';
  const server = new MockSseServer({ replayTtlMs: 60_000 });
  const trace = buildSyntheticTrace(requestId, 16);
  server.registerStream(requestId, trace);

  // Simulate a connection drop after 6 events on the first attempt;
  // ChatStreamStore automatically reconnects with `Last-Event-ID: evt-0006` and finishes cleanly.
  const fetchFn = server.createFetchHandler({
    dropFirstConnectionAfterEvents: 6,
    chunkByteSize: 29, // prime byte chunk size to exercise split UTF-8 and SSE line framing
  });

  const store = new ChatStreamStore({
    endpointUrl: 'https://stream.example.test/api/chat/stream',
    flushIntervalMs: 16,
    maxAutoReconnects: 2,
    reconnectDelayMs: 10,
    fetchFn,
  });

  store.sendPrompt('Explain SSE boundary validation and signal batching.', requestId);

  // Wait for completion
  while (store.status() === 'streaming') {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  console.log('=== STREAMING DEMO RESULT ===');
  console.log(`Status:           ${store.status()}`);
  console.log(`Active Request:   ${store.activeRequestId()}`);
  console.log(`Last Event ID:    ${store.lastEventId()}`);
  console.log(`Auto Reconnects:  ${store.reconnectCount()}`);
  console.log(`Signal Writes:    ${store.signalWriteCount()}`);
  console.log(`Tool Calls:       ${store.toolCalls().length} (${store.toolCalls().map((t) => t.tool).join(', ')})`);
  console.log(`Cached MD Blocks: ${store.renderedMarkdown().cachedBlockCount}`);
  console.log(`Output Length:    ${store.text().length} chars`);
}

await main();

