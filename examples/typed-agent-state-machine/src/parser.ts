import type { ToolArgsByName, ToolCall, ToolName } from './tool-calls';

// #region parser
export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code:
        | 'malformed_json'
        | 'not_an_object'
        | 'unknown_property'
        | 'invalid_discriminant'
        | 'invalid_field';
      readonly fieldPath: string;
      readonly message: string;
    };

export type ModelTurnResponse =
  | {
      readonly kind: 'final_answer';
      readonly answerMarkdown: string;
      readonly citations: readonly string[];
    }
  | {
      readonly kind: 'tool_request';
      readonly call: ToolCall;
      readonly rationale: string;
    };

/**
 * Strips leading/trailing Markdown ```json ... ``` fences that LLMs frequently
 * wrap around JSON responses even when instructed to return raw JSON.
 */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1]!.trim() : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findUnknownKeys(
  obj: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): string[] {
  return Object.keys(obj).filter((key) => !allowedKeys.has(key));
}

/**
 * Validates a finite safe integer within an inclusive `[min, max]` range.
 * Catches `NaN`, `Infinity`, floats (`3.5`), stringified numbers (`"10"`), and out-of-bounds values.
 */
export function isBoundedSafeInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

const SEARCH_DOCS_KEYS = new Set(['query', 'limit']);
const RUN_SQL_KEYS = new Set(['sql', 'readOnly']);
const CREATE_TICKET_KEYS = new Set(['title', 'severity']);
const SEVERITIES = new Set(['low', 'medium', 'high'] as const);

export function validateToolArgs<K extends ToolName>(
  tool: K,
  rawArgs: unknown,
): ParseOutcome<ToolArgsByName[K]> {
  if (!isPlainObject(rawArgs)) {
    return {
      ok: false,
      code: 'not_an_object',
      fieldPath: 'call.args',
      message: 'Tool arguments must be a plain JSON object (arrays and primitives are rejected).',
    };
  }

  switch (tool) {
    case 'search_docs': {
      const unknown = findUnknownKeys(rawArgs, SEARCH_DOCS_KEYS);
      if (unknown.length > 0) {
        return {
          ok: false,
          code: 'unknown_property',
          fieldPath: `call.args.${unknown[0]}`,
          message: `Unknown property "${unknown[0]}" in search_docs args.`,
        };
      }
      const query = rawArgs['query'];
      const limit = rawArgs['limit'];
      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.query',
          message: '"query" must be a non-empty string.',
        };
      }
      if (!isBoundedSafeInteger(limit, 1, 50)) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.limit',
          message: '"limit" must be a safe integer between 1 and 50.',
        };
      }
      return {
        ok: true,
        value: { query: query.trim(), limit } as ToolArgsByName[K],
      };
    }

    case 'run_sql': {
      const unknown = findUnknownKeys(rawArgs, RUN_SQL_KEYS);
      if (unknown.length > 0) {
        return {
          ok: false,
          code: 'unknown_property',
          fieldPath: `call.args.${unknown[0]}`,
          message: `Unknown property "${unknown[0]}" in run_sql args.`,
        };
      }
      const sql = rawArgs['sql'];
      const readOnly = rawArgs['readOnly'];
      if (typeof sql !== 'string' || sql.trim().length === 0) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.sql',
          message: '"sql" must be a non-empty string.',
        };
      }
      if (readOnly !== true) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.readOnly',
          message: '"readOnly" must be literal true.',
        };
      }
      return {
        ok: true,
        value: { sql: sql.trim(), readOnly: true } as ToolArgsByName[K],
      };
    }

    case 'create_ticket': {
      const unknown = findUnknownKeys(rawArgs, CREATE_TICKET_KEYS);
      if (unknown.length > 0) {
        return {
          ok: false,
          code: 'unknown_property',
          fieldPath: `call.args.${unknown[0]}`,
          message: `Unknown property "${unknown[0]}" in create_ticket args.`,
        };
      }
      const title = rawArgs['title'];
      const severity = rawArgs['severity'];
      if (typeof title !== 'string' || title.trim().length === 0) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.title',
          message: '"title" must be a non-empty string.',
        };
      }
      if (
        typeof severity !== 'string' ||
        !SEVERITIES.has(severity as 'low' | 'medium' | 'high')
      ) {
        return {
          ok: false,
          code: 'invalid_field',
          fieldPath: 'call.args.severity',
          message: '"severity" must be one of "low", "medium", or "high".',
        };
      }
      return {
        ok: true,
        value: {
          title: title.trim(),
          severity: severity as 'low' | 'medium' | 'high',
        } as ToolArgsByName[K],
      };
    }
  }
}

const FINAL_ANSWER_KEYS = new Set(['kind', 'answerMarkdown', 'citations']);
const TOOL_REQUEST_KEYS = new Set(['kind', 'call', 'rationale']);
const CALL_ENVELOPE_KEYS = new Set(['callId', 'tool', 'args']);
const ALLOWED_TOOLS: ReadonlySet<ToolName> = new Set([
  'search_docs',
  'run_sql',
  'create_ticket',
]);

/**
 * Runtime boundary parser for raw LLM output.
 * Synchronizes runtime checks with the static `ModelTurnResponse` discriminated union.
 */
export function parseModelTurnResponse(rawText: string): ParseOutcome<ModelTurnResponse> {
  const cleaned = stripJsonFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      code: 'malformed_json',
      fieldPath: '$',
      message: `Malformed JSON: ${(err as Error).message}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      code: 'not_an_object',
      fieldPath: '$',
      message: 'Top-level response must be a plain JSON object.',
    };
  }

  const kind = parsed['kind'];
  if (kind === 'final_answer') {
    const unknown = findUnknownKeys(parsed, FINAL_ANSWER_KEYS);
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'unknown_property',
        fieldPath: unknown[0]!,
        message: `Unknown top-level property "${unknown[0]}" on final_answer.`,
      };
    }
    const answerMarkdown = parsed['answerMarkdown'];
    const citations = parsed['citations'];
    if (typeof answerMarkdown !== 'string' || answerMarkdown.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_field',
        fieldPath: 'answerMarkdown',
        message: '"answerMarkdown" must be a non-empty string.',
      };
    }
    if (
      !Array.isArray(citations) ||
      !citations.every((item) => typeof item === 'string' && item.trim().length > 0)
    ) {
      return {
        ok: false,
        code: 'invalid_field',
        fieldPath: 'citations',
        message: '"citations" must be an array of non-empty strings.',
      };
    }
    return {
      ok: true,
      value: {
        kind: 'final_answer',
        answerMarkdown,
        citations,
      },
    };
  }

  if (kind === 'tool_request') {
    const unknown = findUnknownKeys(parsed, TOOL_REQUEST_KEYS);
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'unknown_property',
        fieldPath: unknown[0]!,
        message: `Unknown top-level property "${unknown[0]}" on tool_request.`,
      };
    }
    const rationale = parsed['rationale'];
    if (typeof rationale !== 'string' || rationale.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_field',
        fieldPath: 'rationale',
        message: '"rationale" must be a non-empty string.',
      };
    }

    const rawCall = parsed['call'];
    if (!isPlainObject(rawCall)) {
      return {
        ok: false,
        code: 'not_an_object',
        fieldPath: 'call',
        message: '"call" must be a plain JSON object.',
      };
    }
    const unknownCallKeys = findUnknownKeys(rawCall, CALL_ENVELOPE_KEYS);
    if (unknownCallKeys.length > 0) {
      return {
        ok: false,
        code: 'unknown_property',
        fieldPath: `call.${unknownCallKeys[0]}`,
        message: `Unknown property "${unknownCallKeys[0]}" on tool call envelope.`,
      };
    }

    const callId = rawCall['callId'];
    const tool = rawCall['tool'];
    if (typeof callId !== 'string' || callId.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_field',
        fieldPath: 'call.callId',
        message: '"call.callId" must be a non-empty string.',
      };
    }
    if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool as ToolName)) {
      return {
        ok: false,
        code: 'invalid_discriminant',
        fieldPath: 'call.tool',
        message: `Unknown tool "${String(tool)}". Allowed: search_docs, run_sql, create_ticket.`,
      };
    }

    const typedTool = tool as ToolName;
    const argsOutcome = validateToolArgs(typedTool, rawCall['args']);
    if (!argsOutcome.ok) {
      return argsOutcome;
    }

    const validatedCall = {
      callId: callId.trim(),
      tool: typedTool,
      args: argsOutcome.value,
    } as ToolCall;

    return {
      ok: true,
      value: {
        kind: 'tool_request',
        call: validatedCall,
        rationale: rationale.trim(),
      },
    };
  }

  return {
    ok: false,
    code: 'invalid_discriminant',
    fieldPath: 'kind',
    message: `Unknown response kind "${String(kind)}". Expected "final_answer" or "tool_request".`,
  };
}
// #endregion parser

