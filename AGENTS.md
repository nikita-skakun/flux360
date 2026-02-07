# Agent Guidelines

Read [README.md](README.md) first for an overview of the project, current features, and future ideas. Keep the README up to date as features evolve to maintain an evergreen reference.

## Package Manager

- Use **bun** instead of npm for all package management commands
- Install: `bun add <package>`
- Remove: `bun remove <package>`
- Run scripts: `bun run <script>`
- Typecheck: `bun run tsc --noEmit`

## Development

- Never run `bun run dev` or the dev server - it will lock up the terminal
- Only suggest the user run it themselves

## Environment Variables

- Never read `.env` files directly
- The user will provide API keys and secrets
- If you need to use an API key, let the user set it themselves or provide instructions

## Git

- NEVER commit changes without explicit user permission
- NEVER perform git commands that modify repository state, such as reset, hard reset, revert, or force push, unless explicitly requested by the user

## TypeScript

- Never use `as any` - fix the types properly
- Use proper type annotations and extend types when needed
- Avoid using the non-null assertion operator (!) unless absolutely necessary
- Do not use ESLint disable comments to suppress linting errors. Fix the underlying issues instead