// #region failure-policy
/**
 * Distinguishes failure origins in an LLM/agent pipeline so retry and repair policies
 * do not conflate deterministic client contract bugs with stochastic model outputs
 * or upstream gateway outages.
 */
export type AgentFailureOrigin =
  | {
      /** Client sent an invalid request schema to our own API (e.g. missing prompt or invalid session ID). */
      readonly origin: 'client_contract_error';
      readonly httpStatus: 400 | 422;
      readonly fieldPath: string;
      readonly detail: string;
    }
  | {
      /**
       * The LLM returned malformed JSON or violated the output tool schema.
       * Unlike a deterministic REST webhook, LLM generation is stochastic:
       * a bounded repair prompt (including the exact validation error) can succeed on attempt 2,
       * whereas re-sending the exact same bytes to a deterministic validator never will.
       */
      readonly origin: 'model_output_validation_error';
      readonly fieldPath: string;
      readonly validationMessage: string;
      readonly rawModelSnippet: string;
    }
  | {
      /** Upstream LLM provider returned an HTTP error or timed out. */
      readonly origin: 'provider_transport_error';
      readonly httpStatus: 422 | 429 | 500 | 502 | 503 | 504;
      readonly retryAfterMs?: number;
      readonly providerRequestId?: string;
      /** Whether a non-idempotent side effect may have already started before the failure. */
      readonly sideEffectInFlight: boolean;
    };

export interface RetryRepairBudget {
  readonly maxModelRepairAttempts: number;
  readonly maxTransportRetries: number;
  readonly remainingTimeBudgetMs: number;
  readonly remainingTokenBudget: number;
  readonly estimatedNextAttemptTokens: number;
  readonly baseBackoffMs: number;
}

export type RecoveryDecision =
  | {
      readonly action: 'abort';
      readonly publicStatus: 400 | 422 | 429 | 502 | 503;
      readonly publicMessage: string;
      readonly canUserRetry: boolean;
    }
  | {
      readonly action: 'repair_with_feedback';
      readonly nextAttempt: number;
      readonly delayMs: number;
      readonly feedbackPrompt: string;
    }
  | {
      readonly action: 'retry_transport';
      readonly nextAttempt: number;
      readonly delayMs: number;
    };

/**
 * Evaluates a failure against explicit time, token, attempt, and idempotency budgets.
 *
 * Avoids two common oversimplifications:
 * 1. "HTTP 422 is never retryable": true when a client sends bad input to a deterministic endpoint,
 *    false when our parser rejects a stochastic LLM turn that can be repaired once with field feedback.
 * 2. "HTTP 502/503 is always safe to retry": false if a non-idempotent tool mutation was already
 *    dispatched without an idempotency key, or if the request's wall-clock/token budget is exhausted.
 */
export function decideRecoveryAction(
  failure: AgentFailureOrigin,
  currentAttempt: number,
  budget: RetryRepairBudget,
  signal?: AbortSignal,
): RecoveryDecision {
  if (signal?.aborted) {
    return {
      action: 'abort',
      publicStatus: 422,
      publicMessage: 'Request was cancelled by the caller.',
      canUserRetry: true,
    };
  }

  const hasBudgetForAnotherTurn =
    budget.remainingTimeBudgetMs >= 500 &&
    budget.remainingTokenBudget >= budget.estimatedNextAttemptTokens;

  switch (failure.origin) {
    case 'client_contract_error':
      // Deterministic caller contract error: retrying identical input will always fail.
      return {
        action: 'abort',
        publicStatus: failure.httpStatus,
        publicMessage: `Invalid request field "${failure.fieldPath}": ${failure.detail}`,
        canUserRetry: false,
      };

    case 'model_output_validation_error': {
      if (
        !hasBudgetForAnotherTurn ||
        currentAttempt >= budget.maxModelRepairAttempts
      ) {
        return {
          action: 'abort',
          publicStatus: 422,
          publicMessage:
            'The assistant could not produce a valid structured response within the turn budget.',
          canUserRetry: true,
        };
      }

      return {
        action: 'repair_with_feedback',
        nextAttempt: currentAttempt + 1,
        delayMs: 0,
        feedbackPrompt:
          `Your previous JSON output failed validation at "${failure.fieldPath}": ` +
          `${failure.validationMessage}. Return only a valid JSON object matching the schema.`,
      };
    }

    case 'provider_transport_error': {
      // Never blindly retry when a non-idempotent side effect is already in flight
      if (failure.sideEffectInFlight) {
        return {
          action: 'abort',
          publicStatus: 502,
          publicMessage:
            'Upstream connection dropped while an external action was in flight; automatic retry skipped to prevent duplicate execution.',
          canUserRetry: false,
        };
      }

      // Provider 422 means our prompt/tool schema sent to the model provider is invalid
      if (failure.httpStatus === 422) {
        return {
          action: 'abort',
          publicStatus: 502,
          publicMessage: 'Upstream model rejected the request configuration.',
          canUserRetry: false,
        };
      }

      if (!hasBudgetForAnotherTurn || currentAttempt >= budget.maxTransportRetries) {
        return {
          action: 'abort',
          publicStatus: failure.httpStatus === 429 ? 429 : 503,
          publicMessage: 'Model provider is temporarily unavailable. Please try again shortly.',
          canUserRetry: true,
        };
      }

      const exponentialDelay = budget.baseBackoffMs * Math.pow(2, currentAttempt);
      const delayMs =
        failure.retryAfterMs !== undefined
          ? Math.max(failure.retryAfterMs, exponentialDelay)
          : exponentialDelay;

      if (delayMs > budget.remainingTimeBudgetMs) {
        return {
          action: 'abort',
          publicStatus: failure.httpStatus === 429 ? 429 : 503,
          publicMessage: 'Retry backoff exceeds remaining request time budget.',
          canUserRetry: true,
        };
      }

      return {
        action: 'retry_transport',
        nextAttempt: currentAttempt + 1,
        delayMs,
      };
    }
  }
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /postgres:\/\/[^\s"']+/gi,
];

/**
 * Redacts API keys, bearer tokens, and internal connection strings before an error
 * message leaves the server boundary.
 */
export function sanitizePublicErrorMessage(rawMessage: string): string {
  let sanitized = rawMessage;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}
// #endregion failure-policy

