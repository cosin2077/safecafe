# Security Policy

Safecafe is a non-custodial staking interface. Users sign transactions from their own wallet, Safe, or explicitly selected CLI hot-wallet flow. The web app should never require private keys.

## Reporting

Please report security issues privately to the maintainers before opening a public issue. Include:

- Affected component or command
- Reproduction steps
- Expected impact
- Suggested mitigation, if known

## Secret Handling

- Do not commit `.env` files, private keys, mnemonics, API tokens, or wallet exports.
- Use `.env.example` for public configuration examples.
- If a private key is exposed, consider it compromised and rotate it immediately.
- Prefer Safe Transaction Builder payload export for Safe accounts.
- For CLI EOA sending, prefer `--private-key-prompt` or `--private-key-stdin`; avoid storing signing keys in `.env` or shell history.

## Supported Version

Security fixes are expected to target the latest `main` branch until tagged releases are introduced.
