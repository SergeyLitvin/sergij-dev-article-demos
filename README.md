# sergij.dev — Engineering Article Companion Examples

Standalone, independently runnable reference reconstructions accompanying the engineering articles on [sergij.dev](https://sergij.dev).

Each directory under `examples/` has its own `package.json`, `bun.lock`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, and deterministic synthetic fixtures so it can be installed, typechecked, tested, and executed without parent repository dependencies or external LLM API keys.

## Repository Structure

```text
examples/
  streaming-signals-rxjs/       # Companion to: "Angular Signals vs RxJS for Streaming LLM Responses"
  typed-agent-state-machine/    # Companion to: "TypeScript Discriminated Unions for LLM and Agent Code"
  snippet-manifest.json         # Maps article code blocks to #region markers in tested source files
```

## Prerequisites

- **Bun:** `>= 1.3.0` (verified on Bun `1.4.0`)
- **Node.js:** `>= 22.0.0` (verified on `v26.3.0`)
- **TypeScript:** `^6.0.2` (`strict: true`)

## Quick Verification (All Examples)

```bash
# 1. Verify Streaming Signals + RxJS example
cd examples/streaming-signals-rxjs
bun install --frozen-lockfile
bun run typecheck
bun test
bun run demo
bun run benchmark

# 2. Verify Typed Agent State Machine example
cd ../typed-agent-state-machine
bun install --frozen-lockfile
bun run typecheck
bun test
bun run demo
```

## Scope & Provenance Note

These packages are **clean-room educational reconstructions** using synthetic fixtures to demonstrate the architectural patterns and failure modes discussed in the articles. They contain no confidential employer source code, internal endpoints, or proprietary schemas.

## License

MIT © Serhii Lytvyn
