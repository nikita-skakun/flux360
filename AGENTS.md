# Agent Guidelines

## Coding Standards
- **TypeScript**:
  - Adhere to the strict rules in `tsconfig.json`.
  - Fix types properly; do not use `as any` or non-null assertions (!).
  - Do not extract functions that are only used once.
  - Avoid using optional parameters.
  - Prefer `Record<number, T>` for application state maps and protocol payloads (devices, positions, events). Use `Map` only for in-memory caches or when you need Map-specific behavior (e.g. fast deletion, non-serializable caching, or key types other than string).
  
## 3. Reference
- See [README.md](README.md) for feature overview and architecture.
- Keep `README.md` updated as features evolve.
