import { assertNever, type ToolCall, type ToolName } from './tool-calls';

// #region agent-state-machine
export type AgentRunState =
  | {
      readonly status: 'thinking';
      readonly runId: string;
      readonly prompt: string;
      readonly attempt: number;
    }
  | {
      readonly status: 'awaiting_approval';
      readonly runId: string;
      readonly prompt: string;
      readonly pendingCall: ToolCall;
      readonly rationale: string;
      readonly approvalTokenId: string;
    }
  | {
      readonly status: 'running_tool';
      readonly runId: string;
      readonly prompt: string;
      readonly activeCall: ToolCall;
      readonly approvedBy?: string;
    }
  | {
      readonly status: 'done';
      readonly runId: string;
      readonly answerMarkdown: string;
      readonly citations: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly runId: string;
      readonly reason:
        | 'validation_exhausted'
        | 'provider_unavailable'
        | 'policy_denied'
        | 'tool_execution_error'
        | 'budget_exceeded';
      readonly publicMessage: string;
      readonly canRetryTurn: boolean;
    }
  | {
      readonly status: 'cancelled';
      readonly runId: string;
      readonly cancelledFromStatus: 'thinking' | 'awaiting_approval' | 'running_tool';
    };

export type AgentTransitionEvent =
  | {
      readonly type: 'MODEL_FINAL_ANSWER';
      readonly answerMarkdown: string;
      readonly citations: readonly string[];
    }
  | {
      readonly type: 'MODEL_TOOL_REQUEST';
      readonly call: ToolCall;
      readonly rationale: string;
    }
  | {
      readonly type: 'HUMAN_APPROVED_TOOL';
      readonly approvalTokenId: string;
      readonly reviewerId: string;
    }
  | {
      readonly type: 'HUMAN_REJECTED_TOOL';
      readonly approvalTokenId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'TOOL_COMPLETED';
      readonly callId: string;
    }
  | {
      readonly type: 'TURN_FAILED';
      readonly reason:
        | 'validation_exhausted'
        | 'provider_unavailable'
        | 'policy_denied'
        | 'tool_execution_error'
        | 'budget_exceeded';
      readonly publicMessage: string;
      readonly canRetryTurn: boolean;
    }
  | {
      readonly type: 'USER_CANCELLED';
    };

export interface ServerAuthorizationPolicy {
  /** Tools that require an explicit human approval token on the server before execution. */
  readonly toolsRequiringApproval: ReadonlySet<ToolName>;
  /** Server-side verification of the signed/stored approval token. */
  verifyApprovalToken(tokenId: string, callId: string, reviewerId: string): boolean;
}

export class IllegalStateTransitionError extends Error {
  constructor(
    readonly fromStatus: AgentRunState['status'],
    readonly eventType: AgentTransitionEvent['type'],
    detail?: string,
  ) {
    super(
      `Illegal transition from "${fromStatus}" on event "${eventType}"${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'IllegalStateTransitionError';
  }
}

/**
 * Pure, constrained state-machine reducer for an agent turn.
 *
 * Key guarantees:
 * 1. Impossible states (e.g., `status === 'done'` with an active `pendingCall` or missing `answerMarkdown`)
 *    cannot be represented in `AgentRunState`.
 * 2. Illegal runtime transitions (e.g., `TOOL_COMPLETED` while still in `awaiting_approval`, or
 *    `MODEL_FINAL_ANSWER` after `cancelled`) throw `IllegalStateTransitionError`.
 * 3. Server-side authorization (`ServerAuthorizationPolicy`) decides whether a requested tool
 *    enters `awaiting_approval` or `running_tool`, and verifies the approval token on the server
 *    before transitioning to `running_tool`. Client-side TypeScript types alone never grant permission.
 */
export function transitionAgentState(
  state: AgentRunState,
  event: AgentTransitionEvent,
  policy: ServerAuthorizationPolicy,
): AgentRunState {
  // Global cancellation transition from any non-terminal state
  if (event.type === 'USER_CANCELLED') {
    if (
      state.status === 'thinking' ||
      state.status === 'awaiting_approval' ||
      state.status === 'running_tool'
    ) {
      return {
        status: 'cancelled',
        runId: state.runId,
        cancelledFromStatus: state.status,
      };
    }
    throw new IllegalStateTransitionError(
      state.status,
      event.type,
      'Cannot cancel a run that is already in a terminal state.',
    );
  }

  if (event.type === 'TURN_FAILED') {
    if (state.status === 'done' || state.status === 'cancelled') {
      throw new IllegalStateTransitionError(state.status, event.type);
    }
    return {
      status: 'failed',
      runId: state.runId,
      reason: event.reason,
      publicMessage: event.publicMessage,
      canRetryTurn: event.canRetryTurn,
    };
  }

  switch (state.status) {
    case 'thinking': {
      switch (event.type) {
        case 'MODEL_FINAL_ANSWER':
          return {
            status: 'done',
            runId: state.runId,
            answerMarkdown: event.answerMarkdown,
            citations: event.citations,
          };

        case 'MODEL_TOOL_REQUEST': {
          const requiresApproval = policy.toolsRequiringApproval.has(event.call.tool);
          if (requiresApproval) {
            return {
              status: 'awaiting_approval',
              runId: state.runId,
              prompt: state.prompt,
              pendingCall: event.call,
              rationale: event.rationale,
              approvalTokenId: `apr-${state.runId}-${event.call.callId}`,
            };
          }
          return {
            status: 'running_tool',
            runId: state.runId,
            prompt: state.prompt,
            activeCall: event.call,
          };
        }

        default:
          throw new IllegalStateTransitionError(state.status, event.type);
      }
    }

    case 'awaiting_approval': {
      switch (event.type) {
        case 'HUMAN_APPROVED_TOOL': {
          if (event.approvalTokenId !== state.approvalTokenId) {
            throw new IllegalStateTransitionError(
              state.status,
              event.type,
              'Approval token mismatch.',
            );
          }
          const authorized = policy.verifyApprovalToken(
            event.approvalTokenId,
            state.pendingCall.callId,
            event.reviewerId,
          );
          if (!authorized) {
            return {
              status: 'failed',
              runId: state.runId,
              reason: 'policy_denied',
              publicMessage: 'Tool execution was denied by server authorization policy.',
              canRetryTurn: false,
            };
          }
          return {
            status: 'running_tool',
            runId: state.runId,
            prompt: state.prompt,
            activeCall: state.pendingCall,
            approvedBy: event.reviewerId,
          };
        }

        case 'HUMAN_REJECTED_TOOL':
          return {
            status: 'failed',
            runId: state.runId,
            reason: 'policy_denied',
            publicMessage: `Tool "${state.pendingCall.tool}" was rejected by reviewer: ${event.reason}`,
            canRetryTurn: false,
          };

        default:
          throw new IllegalStateTransitionError(state.status, event.type);
      }
    }

    case 'running_tool': {
      if (event.type === 'TOOL_COMPLETED') {
        if (event.callId !== state.activeCall.callId) {
          throw new IllegalStateTransitionError(
            state.status,
            event.type,
            `Expected completion for callId "${state.activeCall.callId}", got "${event.callId}".`,
          );
        }
        return {
          status: 'thinking',
          runId: state.runId,
          prompt: state.prompt,
          attempt: 1,
        };
      }
      throw new IllegalStateTransitionError(state.status, event.type);
    }

    case 'done':
    case 'failed':
    case 'cancelled':
      throw new IllegalStateTransitionError(
        state.status,
        event.type,
        'Terminal states cannot transition.',
      );

    default:
      return assertNever(state, 'Unhandled AgentRunState');
  }
}
// #endregion agent-state-machine

