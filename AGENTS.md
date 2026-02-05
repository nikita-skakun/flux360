# Agent Guidelines

## Package Manager

- Use **bun** instead of npm for all package management commands
- Install: `bun add <package>`
- Remove: `bun remove <package>`
- Run scripts: `bun run <script>`
- Tests: `bun test`

## Development

- Never run `bun run dev` or the dev server - it will lock up the terminal
- Only suggest the user run it themselves

## Environment Variables

- Never read `.env` files directly
- The user will provide API keys and secrets
- If you need to use an API key, let the user set it themselves or provide instructions
