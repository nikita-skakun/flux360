# Agent Guidelines

## 1. Environment & Tools
- **Runtime**: Use `bun` for all operations.
  - Install: `bun add <package>`
  - Lint: `bun run lint`
  - Typecheck: `bun run tsc --noEmit`
- **Restrictions**:
  - **NEVER** run `bun run dev` (locks terminal). Suggest the user run it.
  - **NEVER** read `config.json` directly. Ask the user to handle secrets.

## 2. Coding Standards
- **TypeScript**:
  - Adhere to the strict rules in `tsconfig.json` and `eslint.config.js`.
  - Fix types properly; do not use `as any` or non-null assertions (!).
  - **Do not** use `eslint-disable` comments. Fix the root cause.
  - Do not extract functions that are only used once.
  - Avoid using optional parameters.
  - Prefer `Record<number, T>` for application state maps and protocol payloads (devices, positions, events). Use `Map` only for in-memory caches or when you need Map-specific behavior (e.g. fast deletion, non-serializable caching, or key types other than string).
- **Git Safety**:
  - **NEVER** commit without explicit user permission.
  - **NEVER** run destructive commands (reset, force push) without explicit request.

## 3. Reference
- See [README.md](README.md) for feature overview and architecture.
- Keep `README.md` updated as features evolve.
