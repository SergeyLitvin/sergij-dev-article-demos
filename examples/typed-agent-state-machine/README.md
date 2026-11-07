# Typed Agent State Machine & Tool Dispatch in TypeScript

Runnable companion project for the article **"TypeScript Discriminated Unions for LLM and Agent Code"** (`/articles/discriminated-unions-typescript`).

## Purpose

This project demonstrates how to pair **compile-time discriminated unions** with **runtime boundary parsers**, **constrained state-machine transitions**, **server-side authorization policies**, and **nuanced retry/repair budgets** for LLM tool-calling systems.

All fixtures are deterministic and require no API keys or external network requests.

## Prerequisites

- **Bun**: `>= 1.3.0` (verified on `Bun 1.3.11`)
- **Node.js**: `>= 20.0.0`

## Commands

```bash
# Install dependencies
bun install

# Run strict TypeScript compiler checks (also verifies negative @ts-expect-error tests)
bun run typecheck

# Run runtime & type-level unit tests
bun test

# Run the deterministic multi-turn agent demo
bun run demo
```

## Architecture & What Is Tested

1. **Correlated Tool Dispatch (`src/tool-calls.ts`)**:
   - Distributive mapped type (`ToolCall`) linking each `ToolName` to its exact argument contract (`ToolArgsByName[K]`).
   - Exhaustiveness helper (`assertNever`) and strict `dispatchToolCall` without unsafe casts.
2. **Synchronized Boundary Parser (`src/parser.ts`)**:
   - `stripJsonFence` removes Markdown ```` ```json ```` wrappers before `JSON.parse`.
   - Rejects arrays where objects are expected (`!Array.isArray(value)`), rejects unknown properties (`findUnknownKeys`), and enforces bounded safe integer constraints (`isBoundedSafeInteger` checking `Number.isFinite`, `Number.isSafeInteger`, and `min`/`max` bounds).
3. **Constrained Agent State Machine (`src/agent-state-machine.ts`)**:
   - Models `thinking | awaiting_approval | running_tool | done | failed | cancelled`.
   - Enforces legal transitions (`transitionAgentState`) and demonstrates that server-side authorization (`ServerAuthorizationPolicy`) is a runtime policy check on the server, never just a client-side TypeScript union.
4. **Failure Origins & Bounded Retry/Repair Policy (`src/failure-policy.ts`)**:
   - Distinguishes deterministic `client_contract_error` (never retry) from stochastic `model_output_validation_error` (bounded repair with field-level feedback) and `provider_transport_error` (exponential backoff with idempotency, time, and token budget checks).
   - Redacts secrets and connection strings (`sanitizePublicErrorMessage`) before error payloads leave the server.
5. **Negative Type-Level Tests (`tests/types.spec.ts`)**:
   - Uses `@ts-expect-error` verified by `tsc --noEmit` to prove that mismatched tool arguments, missing handlers, and un-narrowed state reads fail at compile time.

## Limitations

- The runtime validator in `src/parser.ts` is intentionally written in zero-dependency TypeScript so every check is visible line by line. In larger production services with dozens of schemas, a schema library such as TypeBox or Zod can generate the validator and static type from a single definition, provided custom numeric and unknown-key refinements are configured explicitly.

