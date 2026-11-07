import { describe, expect, it } from 'vitest';
import {
  dispatchToolCall,
  type ToolCall,
  type ToolHandlerMap,
} from '../src/tool-calls';
import type { AgentRunState } from '../src/agent-state-machine';

/**
 * Compile-time negative type tests verified by `tsc --noEmit`.
 * Every `@ts-expect-error` directive below MUST trigger a real TypeScript compiler error;
 * if any invalid assignment were accidentally allowed by our union types, `tsc --noEmit`
 * would fail with "Unused '@ts-expect-error' directive".
 */
describe('Type-level guarantees (verified by tsc --noEmit)', () => {
  it('prevents mismatched tool name and tool arguments in ToolCall union', () => {
    const validCall: ToolCall = {
      callId: 'c-1',
      tool: 'search_docs',
      args: { query: 'signals', limit: 5 },
    };
    expect(validCall.tool).toBe('search_docs');

    const mismatchedArgs: ToolCall = {
      callId: 'c-2',
      tool: 'search_docs',
      // @ts-expect-error - `search_docs` cannot accept `run_sql` arguments
      args: { sql: 'SELECT 1', readOnly: true as const },
    };
    void mismatchedArgs;

    const nonReadOnlySql: ToolCall = {
      callId: 'c-3',
      tool: 'run_sql',
      // @ts-expect-error - `run_sql` requires `readOnly: true`, not `false`
      args: { sql: 'DROP TABLE users', readOnly: false },
    };
    void nonReadOnlySql;
  });

  it('requires exhaustive tool handlers in ToolHandlerMap', () => {
    // @ts-expect-error - Missing `create_ticket` handler must fail compilation
    const incompleteHandlers: ToolHandlerMap<string> = {
      search_docs: (args) => args.query,
      run_sql: (args) => args.sql,
    };
    void incompleteHandlers;
    expect(typeof dispatchToolCall).toBe('function');
  });

  it('prevents reading answerMarkdown on a non-done AgentRunState without narrowing', () => {
    const state = {
      status: 'thinking',
      runId: 'r-1',
      prompt: 'hi',
      attempt: 1,
    } as AgentRunState;

    // @ts-expect-error - `answerMarkdown` does not exist on un-narrowed `AgentRunState`
    const illegalRead = state.answerMarkdown;
    void illegalRead;

    if (state.status === 'done') {
      // Narrowed cleanly:
      const safeRead: string = state.answerMarkdown;
      expect(typeof safeRead).toBe('string');
    }
  });
});
