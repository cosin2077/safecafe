# Safecafe CLI

CLI entrypoint for Safecafe, a non-custodial Safenet staking toolkit.

The default CLI flow is planning and exporting transactions. Advanced users can also submit transactions from a local EOA hot wallet, but Safecafe never accepts a raw private key as a command-line argument.

## Development

```bash
pnpm cli --help
pnpm cli status --mock
pnpm build:cli
pnpm cli:packed status --mock
```

## Use

```bash
safecafe guide
safecafe status --account 0xYourAddress
safecafe validators --active
safecafe stake --account 0xYourAddress --validator "Core Contributors" --amount 100 --dry-run
safecafe unstake --account 0xYourAddress --validator "Core Contributors" --amount 25 --dry-run
safecafe withdrawals --account 0xYourAddress
safecafe rewards --account 0xYourAddress
safecafe claim-withdrawal --account 0xYourAddress --dry-run
safecafe claim-rewards --account 0xYourAddress --dry-run
safecafe stake --account 0xYourSafe --validator "Core Contributors" --amount 100 --safe-payload ./safecafe-safe.json
safecafe stake --account 0xYourEOA --validator "Core Contributors" --amount 100 --send --private-key-prompt --yes
```

`--mock` is available only for local samples and documentation screenshots.

## Signing Model

Safecafe supports three signing modes:

1. Safe accounts: use `--safe-payload`, review the JSON payload, and sign inside Safe.
2. EOA accounts, interactive: use `--send --private-key-prompt --yes`. The private key is hidden while typed and used in memory for that run only.
3. EOA accounts, automation: use `--send --private-key-stdin --yes` from a password manager or secret manager. `--private-key-env <name>` is available for controlled automation, but it should not be stored in `.env`, shell history, or shared CI logs.

Live sending is intentionally explicit:

- `--send` only supports EOA hot-wallet accounts. Safe contract accounts should use `--safe-payload`.
- `--account` is required and must match the provided private key.
- `--yes` is required before any live transaction is submitted.
- Do not pass private keys as command-line arguments. Process arguments are commonly visible to other local tools.

## Bun

The source CLI supports Bun:

```bash
pnpm cli:bun status --mock
```

The root project also includes a build script for Bun single-file binaries. It first builds the CLI entrypoint, then compiles that entrypoint into a platform-specific executable:

```bash
pnpm build:cli:bun
./cli/dist-bin/safecafe status --mock
```
