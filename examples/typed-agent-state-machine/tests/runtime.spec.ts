import { describe, expect, it } from 'vitest';
import {
  IllegalStateTransitionError,
  transitionAgentState,
  type AgentRunState,
  type ServerAuthorizationPolicy,
} from '../src/agent-state-machine';
import {
  decideRecoveryAction,
  sanitizePublicErrorMessage,
  type RetryRepairBudget,
} from '../src/failure-policy';
import {
  isBoundedSafeInteger,
  parseModelTurnResponse,
  stripJsonFence,
} from '../src/parser';
import { dispatchToolCall } from '../src/tool-calls';

const defaultPolicy: ServerAuthorizationPolicy = {
  toolsRequiringApproval: new Set(['create_ticket']),
  verifyApprovalToken: (tokenId, callId, reviewerId) =>
    tokenId === `apr-run-1-${callId}` && reviewerId === 'reviewer-1',
};

const defaultBudget: RetryRepairBudget = {
  maxModelRepairAttempts: 2,
  maxTransportRetries: 2,
  remainingTimeBudgetMs: 5_000,
  remainingTokenBudget: 2_000,
  estimatedNextAttemptTokens: 400,
  baseBackoffMs: 100,
};

describe('stripJsonFence & parseModelTurnResponse (runtime boundary validation)', () => {
  it('strips ```json fences and parses a valid tool_request', () => {
    const fenced = `\`\`\`json
{
  "kind": "tool_request",
  "rationale": "Look up retry docs",
  "call": {
    "callId": "c-1",
    "tool": "search_docs",
    "args": { "query": "discriminated unions", "limit": 5 }
  }
}
\`\`\``;

    expect(stripJsonFence(fenced)).toContain('"kind": "tool_request"');
    const res = parseModelTurnResponse(fenced);
    expect(res.ok).toBe(true);
    if (res.ok && res.value.kind === 'tool_request') {
      expect(res.value.call.tool).toBe('search_docs');
      expect(res.value.call.args).toEqual({ query: 'discriminated unions', limit: 5 });
    }
  });

  it('rejects malformed JSON', () => {
    const res = parseModelTurnResponse('{ "kind": "final_answer", broken ');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('malformed_json');
    }
  });

  it('rejects arrays where plain objects are expected (typeof [] === "object" trap)', () => {
    // Top-level array
    const topArray = parseModelTurnResponse('[1, 2, 3]');
    expect(topArray.ok).toBe(false);
    if (!topArray.ok) {
      expect(topArray.code).toBe('not_an_object');
    }

    // Array inside call.args (e.g. slides/args passed as `[1, 2, 3]`)
    const argsArray = parseModelTurnResponse(
      JSON.stringify({
        kind: 'tool_request',
        rationale: 'Test array args',
        call: {
          callId: 'c-1',
          tool: 'search_docs',
          args: [1, 2, 3],
        },
      }),
    );
    expect(argsArray.ok).toBe(false);
    if (!argsArray.ok) {
      expect(argsArray.code).toBe('not_an_object');
      expect(argsArray.fieldPath).toBe('call.args');
    }
  });

  it('rejects unknown properties on top-level objects and tool arguments', () => {
    const res = parseModelTurnResponse(
      JSON.stringify({
        kind: 'tool_request',
        rationale: 'Search',
        call: {
          callId: 'c-1',
          tool: 'search_docs',
          args: { query: 'ts', limit: 5, injectedFlag: true },
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('unknown_property');
      expect(res.fieldPath).toBe('call.args.injectedFlag');
    }
  });

  it('rejects unknown tools and invalid discriminants', () => {
    const badKind = parseModelTurnResponse(JSON.stringify({ kind: 'hallucinated_mode' }));
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.code).toBe('invalid_discriminant');
    }

    const badTool = parseModelTurnResponse(
      JSON.stringify({
        kind: 'tool_request',
        rationale: 'Delete everything',
        call: { callId: 'c-1', tool: 'drop_table', args: {} },
      }),
    );
    expect(badTool.ok).toBe(false);
    if (!badTool.ok) {
      expect(badTool.code).toBe('invalid_discriminant');
      expect(badTool.fieldPath).toBe('call.tool');
    }
  });

  it('enforces deliberate numeric constraints (finite, safe integer, min/max bounds)', () => {
    expect(isBoundedSafeInteger(10, 1, 50)).toBe(true);
    expect(isBoundedSafeInteger(0, 1, 50)).toBe(false);
    expect(isBoundedSafeInteger(51, 1, 50)).toBe(false);
    expect(isBoundedSafeInteger(3.14, 1, 50)).toBe(false);
    expect(isBoundedSafeInteger(Number.NaN, 1, 50)).toBe(false);
    expect(isBoundedSafeInteger(Number.POSITIVE_INFINITY, 1, 50)).toBe(false);

    const outOfBounds = parseModelTurnResponse(
      JSON.stringify({
        kind: 'tool_request',
        rationale: 'Too many results',
        call: {
          callId: 'c-1',
          tool: 'search_docs',
          args: { query: 'angular', limit: -5 },
        },
      }),
    );
    expect(outOfBounds.ok).toBe(false);
    if (!outOfBounds.ok) {
      expect(outOfBounds.fieldPath).toBe('call.args.limit');
    }
  });
});

describe('dispatchToolCall & transitionAgentState (state machine + server authorization)', () => {
  it('dispatches correlated tool calls to the matching handler', async () => {
    const out = await dispatchToolCall(
      {
        callId: 'c-9',
        tool: 'run_sql',
        args: { sql: 'SELECT count(*) FROM articles', readOnly: true },
      },
      {
        search_docs: () => 'docs',
        run_sql: (args, id) => `sql:${id}:${args.sql}:${args.readOnly}`,
        create_ticket: () => 'ticket',
      },
    );
    expect(out).toBe('sql:c-9:SELECT count(*) FROM articles:true');
  });

  it('routes low-risk tools directly to running_tool and sensitive tools to awaiting_approval', () => {
    const initial: AgentRunState = {
      status: 'thinking',
      runId: 'run-1',
      prompt: 'Test',
      attempt: 1,
    };

    const afterSearch = transitionAgentState(
      initial,
      {
        type: 'MODEL_TOOL_REQUEST',
        rationale: 'Read docs',
        call: { callId: 'c-1', tool: 'search_docs', args: { query: 'a', limit: 3 } },
      },
      defaultPolicy,
    );
    expect(afterSearch.status).toBe('running_tool');

    const afterTicket = transitionAgentState(
      initial,
      {
        type: 'MODEL_TOOL_REQUEST',
        rationale: 'File bug',
        call: {
          callId: 'c-2',
          tool: 'create_ticket',
          args: { title: 'Bug', severity: 'high' },
        },
      },
      defaultPolicy,
    );
    expect(afterTicket.status).toBe('awaiting_approval');
  });

  it('rejects illegal transitions such as TOOL_COMPLETED from awaiting_approval or transitions after done', () => {
    const awaiting: AgentRunState = {
      status: 'awaiting_approval',
      runId: 'run-1',
      prompt: 'Test',
      pendingCall: {
        callId: 'c-2',
        tool: 'create_ticket',
        args: { title: 'Bug', severity: 'high' },
      },
      rationale: 'File bug',
      approvalTokenId: 'apr-run-1-c-2',
    };

    expect(() =>
      transitionAgentState(
        awaiting,
        { type: 'TOOL_COMPLETED', callId: 'c-2' },
        defaultPolicy,
      ),
    ).toThrowError(IllegalStateTransitionError);

    const doneState: AgentRunState = {
      status: 'done',
      runId: 'run-1',
      answerMarkdown: 'All set.',
      citations: [],
    };

    expect(() =>
      transitionAgentState(doneState, { type: 'USER_CANCELLED' }, defaultPolicy),
    ).toThrowError(IllegalStateTransitionError);
  });

  it('transitions to failed (policy_denied) when server approval token verification fails', () => {
    const awaiting: AgentRunState = {
      status: 'awaiting_approval',
      runId: 'run-1',
      prompt: 'Test',
      pendingCall: {
        callId: 'c-2',
        tool: 'create_ticket',
        args: { title: 'Bug', severity: 'high' },
      },
      rationale: 'File bug',
      approvalTokenId: 'apr-run-1-c-2',
    };

    const next = transitionAgentState(
      awaiting,
      {
        type: 'HUMAN_APPROVED_TOOL',
        approvalTokenId: 'apr-run-1-c-2',
        reviewerId: 'unauthorized-user',
      },
      defaultPolicy,
    );

    expect(next.status).toBe('failed');
    if (next.status === 'failed') {
      expect(next.reason).toBe('policy_denied');
      expect(next.canRetryTurn).toBe(false);
    }
  });
});

describe('decideRecoveryAction & sanitizePublicErrorMessage (retry/repair policy)', () => {
  it('never retries deterministic client_contract_error (400/422)', () => {
    const decision = decideRecoveryAction(
      {
        origin: 'client_contract_error',
        httpStatus: 422,
        fieldPath: 'prompt',
        detail: 'Prompt cannot be empty',
      },
      1,
      defaultBudget,
    );
    expect(decision.action).toBe('abort');
  });

  it('repairs model_output_validation_error with field feedback while within repair budget, then aborts', () => {
    const attempt1 = decideRecoveryAction(
      {
        origin: 'model_output_validation_error',
        fieldPath: 'call.args.limit',
        validationMessage: '"limit" must be between 1 and 50',
        rawModelSnippet: '{"limit": 500}',
      },
      1,
      defaultBudget,
    );
    expect(attempt1.action).toBe('repair_with_feedback');
    if (attempt1.action === 'repair_with_feedback') {
      expect(attempt1.feedbackPrompt).toContain('call.args.limit');
    }

    const exhausted = decideRecoveryAction(
      {
        origin: 'model_output_validation_error',
        fieldPath: 'call.args.limit',
        validationMessage: '"limit" must be between 1 and 50',
        rawModelSnippet: '{"limit": 500}',
      },
      2, // equals maxModelRepairAttempts
      defaultBudget,
    );
    expect(exhausted.action).toBe('abort');
  });

  it('skips automatic transport retry on 502/503 when a non-idempotent side effect is in flight', () => {
    const unsafe502 = decideRecoveryAction(
      {
        origin: 'provider_transport_error',
        httpStatus: 502,
        sideEffectInFlight: true,
      },
      1,
      defaultBudget,
    );
    expect(unsafe502.action).toBe('abort');

    const safe503 = decideRecoveryAction(
      {
        origin: 'provider_transport_error',
        httpStatus: 503,
        sideEffectInFlight: false,
      },
      1,
      defaultBudget,
    );
    expect(safe503.action).toBe('retry_transport');
  });

  it('redacts API keys, bearer tokens, and database URLs from public error messages', () => {
    const raw =
      'Failed calling upstream with key sk-proj-1234567890abcdef and Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 against postgres://admin:secret@db.internal:5432/prod';
    const clean = sanitizePublicErrorMessage(raw);

    expect(clean).not.toContain('sk-proj-');
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(clean).not.toContain('postgres://admin:secret');
    expect(clean).toContain('[REDACTED]');
  });
});

