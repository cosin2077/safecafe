# Safecafe

Safecafe is a standalone non-custodial interface for Safenet staking. It includes the web app, CLI, protocol reads, transaction planning, Safe Transaction Builder payload export, and shared utilities in one project.

## Structure

- `src/app`: React application surface
- `src/protocol`: contract addresses, reads, rewards, validators, formatting, and transaction plans
- `src/shared`: browser and CLI helpers shared by the app entrypoints
- `cli`: command-line entrypoint and CLI build config
- `public`: deploy-time static assets and routing files

## Development

```bash
pnpm install
pnpm dev
pnpm check
pnpm build
```

## CLI

```bash
pnpm cli status --mock
pnpm build:cli
pnpm cli:packed status --mock
```
