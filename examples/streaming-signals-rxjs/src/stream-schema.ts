// #region stream-schema
export type ToolName = 'search_docs' | 'run_query' | 'create_ticket';

export type StreamFailureReason =
  | 'network_drop'
  | 'rate_limit'
  | 'context_length_exceeded'
  | 'transport_eof_without_done'
  | 'malformed_frame'
  | 'invalid_event_payload';

export type StreamEvent =
  | {
      readonly kind: 'token';
      readonly eventId: string;
      readonly requestId: string;
      readonly value: string;
    }
  | {
      readonly kind: 'tool_call';
      readonly eventId: string;
      readonly requestId: string;
      readonly callId: string;
      readonly tool: ToolName;
      readonly argsJson: string;
      readonly idempotent: boolean;
    }
  | {
      readonly kind: 'done';
      readonly eventId: string;
      readonly requestId: string;
      readonly finishReason: 'stop' | 'length' | 'tool_calls';
    }
  | {
      readonly kind: 'error';
      readonly eventId: string;
      readonly requestId: string;
      readonly reason: StreamFailureReason;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    };

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ALLOWED_TOOLS: ReadonlySet<ToolName> = new Set([
  'search_docs',
  'run_query',
  'create_ticket',
]);

const ALLOWED_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls'] as const);

const ALLOWED_FAILURE_REASONS: ReadonlySet<StreamFailureReason> = new Set([
  'network_drop',
  'rate_limit',
  'context_length_exceeded',
  'transport_eof_without_done',
  'malformed_frame',
  'invalid_event_payload',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime boundary validator for SSE JSON payloads.
 * Replaces unchecked `JSON.parse(raw) as StreamEvent` casts at the network boundary.
 */
export function parseStreamEventPayload(
  rawJson: string,
  fallbackEventId?: string,
): ValidationResult<StreamEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      error: `Malformed JSON in SSE data field: ${(err as Error).message}`,
    };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, error: 'SSE payload must be a JSON object.' };
  }

  const kind = parsed['kind'];
  const requestId = parsed['requestId'];
  const eventId =
    typeof parsed['eventId'] === 'string' && parsed['eventId'].length > 0
      ? parsed['eventId']
      : fallbackEventId;

  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, error: 'Missing or invalid string field "requestId".' };
  }
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'Missing or invalid string field "eventId".' };
  }

  switch (kind) {
    case 'token': {
      const value = parsed['value'];
      if (typeof value !== 'string') {
        return { ok: false, error: 'Token event requires a string "value" field.' };
      }
      return {
        ok: true,
        value: { kind: 'token', eventId, requestId, value },
      };
    }

    case 'tool_call': {
      const callId = parsed['callId'];
      const tool = parsed['tool'];
      const argsJson = parsed['argsJson'];
      const idempotent = parsed['idempotent'];
      if (typeof callId !== 'string' || callId.length === 0) {
        return { ok: false, error: 'tool_call event requires a non-empty "callId".' };
      }
      if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool as ToolName)) {
        return { ok: false, error: `Unknown tool "${String(tool)}" in tool_call event.` };
      }
      if (typeof argsJson !== 'string') {
        return { ok: false, error: 'tool_call event requires string "argsJson".' };
      }
      return {
        ok: true,
        value: {
          kind: 'tool_call',
          eventId,
          requestId,
          callId,
          tool: tool as ToolName,
          argsJson,
          idempotent: typeof idempotent === 'boolean' ? idempotent : tool !== 'create_ticket',
        },
      };
    }

    case 'done': {
      const finishReason = parsed['finishReason'];
      if (
        typeof finishReason !== 'string' ||
        !ALLOWED_FINISH_REASONS.has(finishReason as 'stop' | 'length' | 'tool_calls')
      ) {
        return {
          ok: false,
          error: `Invalid finishReason "${String(finishReason)}" in done event.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'done',
          eventId,
          requestId,
          finishReason: finishReason as 'stop' | 'length' | 'tool_calls',
        },
      };
    }

    case 'error': {
      const reason = parsed['reason'];
      const message = parsed['message'];
      const retryable = parsed['retryable'];
      const retryAfterMs = parsed['retryAfterMs'];
      if (
        typeof reason !== 'string' ||
        !ALLOWED_FAILURE_REASONS.has(reason as StreamFailureReason)
      ) {
        return { ok: false, error: `Invalid failure reason "${String(reason)}".` };
      }
      if (typeof message !== 'string' || message.length === 0) {
        return { ok: false, error: 'Error event requires a non-empty "message".' };
      }
      if (typeof retryable !== 'boolean') {
        return { ok: false, error: 'Error event requires boolean "retryable".' };
      }
      if (
        retryAfterMs !== undefined &&
        (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)
      ) {
        return { ok: false, error: 'Optional "retryAfterMs" must be a non-negative finite number.' };
      }
      return {
        ok: true,
        value: {
          kind: 'error',
          eventId,
          requestId,
          reason: reason as StreamFailureReason,
          message,
          retryable,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown StreamEvent kind "${String(kind)}".`,
      };
  }
}
// #endregion stream-schema

