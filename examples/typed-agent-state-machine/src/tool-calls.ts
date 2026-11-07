// #region tool-calls
export type ToolArgsByName = {
  search_docs: {
    readonly query: string;
    readonly limit: number;
  };
  run_sql: {
    readonly sql: string;
    readonly readOnly: true;
  };
  create_ticket: {
    readonly title: string;
    readonly severity: 'low' | 'medium' | 'high';
  };
};

export type ToolName = keyof ToolArgsByName;

/**
 * Distributive mapped type producing a discriminated union over `tool`.
 * Narrowing `call.tool` automatically narrows `call.args` to that tool's exact shape.
 */
export type ToolCall = {
  [K in ToolName]: {
    readonly callId: string;
    readonly tool: K;
    readonly args: ToolArgsByName[K];
  };
}[ToolName];

export type ToolHandlerMap<R> = {
  readonly [K in ToolName]: (
    args: ToolArgsByName[K],
    callId: string,
  ) => Promise<R> | R;
};

/**
 * Exhaustiveness helper: fails at compile time if a union member is unhandled,
 * and throws a descriptive error if reached at runtime via untyped JS callers.
 */
export function assertNever(value: never, context = 'Unexpected variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

/**
 * Correlated tool dispatcher using an explicit `switch` over the `tool` discriminant.
 * Compiles cleanly under `strict: true` without any `as` casts and enforces exhaustiveness.
 */
export async function dispatchToolCall<R>(
  call: ToolCall,
  handlers: ToolHandlerMap<R>,
): Promise<R> {
  switch (call.tool) {
    case 'search_docs':
      return handlers.search_docs(call.args, call.callId);
    case 'run_sql':
      return handlers.run_sql(call.args, call.callId);
    case 'create_ticket':
      return handlers.create_ticket(call.args, call.callId);
    default:
      return assertNever(call, 'Unhandled tool call variant');
  }
}
// #endregion tool-calls

