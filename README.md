# Traccar Mixture POC

To install dependencies:

```bash
bun install
```

To start a development server (default port 3000):

```bash
bun dev
```

## Traccar POC commands

Fetch real positions from a Traccar server and save to `dev-data/positions.json`:

```fish
# set environment variables and run
set -x TRACCAR_BASE_URL 'http://localhost:8082/api'
set -x TRACCAR_USER 'admin'
set -x TRACCAR_PASS 'admin'
set -x TRACCAR_DEVICE_ID '1'
bun run scripts/fetch_real.ts
```
