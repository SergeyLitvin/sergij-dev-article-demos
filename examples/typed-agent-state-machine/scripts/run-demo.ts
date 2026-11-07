import {
  transitionAgentState,
  type AgentRunState,
  type ServerAuthorizationPolicy,
} from '../src/agent-state-machine';
import { decideRecoveryAction, type RetryRepairBudget } from '../src/failure-policy';
import { parseModelTurnResponse } from '../src/parser';
import { dispatchToolCall } from '../src/tool-calls';

async function main() {
  const policy: ServerAuthorizationPolicy = {
    toolsRequiringApproval: new Set(['create_ticket']),
    verifyApprovalToken: (tokenId, callId, reviewerId) =>
      tokenId === `apr-run-101-${callId}` && reviewerId.startsWith('usr-'),
  };

  let state: AgentRunState = {
    status: 'thinking',
    runId: 'run-101',
    prompt: 'Create a high-severity ticket for the SSE reconnect bug.',
    attempt: 1,
  };

  // Step 1: Simulate first model turn with an invalid numeric limit on search_docs
  const badTurnRaw = JSON.stringify({
    kind: 'tool_request',
    rationale: 'Search incident docs first',
    call: {
      callId: 'call-1',
      tool: 'search_docs',
      args: { query: 'SSE reconnect', limit: 999 }, // exceeds max 50
    },
  });

  const parsed1 = parseModelTurnResponse(badTurnRaw);
  if (!parsed1.ok) {
    const budget: RetryRepairBudget = {
      maxModelRepairAttempts: 2,
      maxTransportRetries: 2,
      remainingTimeBudgetMs: 4000,
      remainingTokenBudget: 2000,
      estimatedNextAttemptTokens: 400,
      baseBackoffMs: 100,
    };
    const decision = decideRecoveryAction(
      {
        origin: 'model_output_validation_error',
        fieldPath: parsed1.fieldPath,
        validationMessage: parsed1.message,
        rawModelSnippet: badTurnRaw,
      },
      1,
      budget,
    );
    console.log('Step 1 (Invalid limit=999):', decision.action);
  }

  // Step 2: Model repairs output and requests `create_ticket` (which requires human approval)
  const validTurnRaw = `\`\`\`json
{
  "kind": "tool_request",
  "rationale": "Open a tracking ticket for the transport EOF regression.",
  "call": {
    "callId": "call-2",
    "tool": "create_ticket",
    "args": {
      "title": "SSE transport EOF treated as done",
      "severity": "high"
    }
  }
}
\`\`\``;

  const parsed2 = parseModelTurnResponse(validTurnRaw);
  if (!parsed2.ok || parsed2.value.kind !== 'tool_request') {
    throw new Error('Expected valid tool_request');
  }

  state = transitionAgentState(
    state,
    {
      type: 'MODEL_TOOL_REQUEST',
      call: parsed2.value.call,
      rationale: parsed2.value.rationale,
    },
    policy,
  );
  console.log('Step 2 (After tool request):', state.status);

  if (state.status !== 'awaiting_approval') {
    throw new Error('Expected awaiting_approval');
  }

  // Step 3: Human reviewer approves the tool on the server
  state = transitionAgentState(
    state,
    {
      type: 'HUMAN_APPROVED_TOOL',
      approvalTokenId: state.approvalTokenId,
      reviewerId: 'usr-serhii',
    },
    policy,
  );
  console.log('Step 3 (After human approval):', state.status);

  if (state.status !== 'running_tool') {
    throw new Error('Expected running_tool');
  }

  const toolResult = await dispatchToolCall(state.activeCall, {
    search_docs: async (args) => `Found ${args.limit} docs for ${args.query}`,
    run_sql: async (args) => `Executed read-only SQL: ${args.sql}`,
    create_ticket: async (args, callId) =>
      `Created ticket [${args.severity.toUpperCase()}] "${args.title}" (callId=${callId})`,
  });
  console.log('Step 4 (Tool output):', toolResult);

  state = transitionAgentState(
    state,
    { type: 'TOOL_COMPLETED', callId: state.activeCall.callId },
    policy,
  );
  state = transitionAgentState(
    state,
    {
      type: 'MODEL_FINAL_ANSWER',
      answerMarkdown: 'Ticket created and linked to incident report.',
      citations: ['INC-2026-09'],
    },
    policy,
  );
  console.log('Step 5 (Final status):', state.status);
}

await main();

