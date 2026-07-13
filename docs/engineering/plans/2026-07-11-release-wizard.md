# Safecafe Interactive Release Wizard Implementation Plan

> This is a completed implementation plan retained as engineering history. Prefer current source code, `README.md`, `CLOUDFLARE.md`, and release tests for product behavior.

**Goal:** Add a resumable `pnpm release` wizard that publishes one Web build to IPFS and Cloudflare, pauses for a manual ENS contenthash update, then verifies the release until the target CID is active.

**Architecture:** A focused TypeScript orchestrator owns workflow state, interaction and verification while delegating Filebase upload to the existing `publish-ipfs.mjs`. Pure release helpers live in a separate module so argument parsing, session validation, CID decoding and redaction can be tested without network or deployment side effects.

**Tech Stack:** TypeScript, Node.js `readline/promises`, `child_process`, viem, pnpm, Biome.

## Global Constraints

- Never update ENS automatically or handle an ENS private key.
- Never commit Git changes automatically.
- Never print secret environment-variable values.
- Build once and deploy/publish the same `dist/` contents.
- Preserve a resumable session after IPFS succeeds.

---

### Task 1: Pure release workflow helpers

**Files:**
- Create: `scripts/release/core.ts`
- Create: `scripts/release/core-test.ts`

**Interfaces:**
- Produces: `parseReleaseArgs(argv)`, `decodeIpfsContenthash(value)`, `redactReleaseError(value)`, secret synchronization helpers, and shared release types.

- [x] Write tests covering default arguments, `--yes`, `--quick`, poll interval bounds, IPFS contenthash decoding, malformed contenthash, secret synchronization, and token/secret redaction.
- [x] Run `pnpm exec tsx scripts/release/core-test.ts` and verify the tests fail because the helper module does not exist.
- [x] Implement the minimal typed helpers without `any` and without network access.
- [x] Re-run the helper tests and verify they pass.

### Task 2: Interactive orchestration

**Files:**
- Create: `scripts/release.ts`
- Create: `scripts/release-test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: executable single-run release workflow and injectable command/fetch/prompt dependencies for tests.

- [x] Write a fake-dependency workflow test proving the exact order: preflight, checks, build, IPFS publish, gateway verification, Cloudflare deploy, manual ENS pause, ENS polling, final verification.
- [x] Add tests proving the exact linear workflow, transient ENS/final verification retries, and secret-safe rendered errors.
- [x] Run `pnpm exec tsx scripts/release-test.ts` and verify it fails before implementation.
- [x] Implement structured ANSI logging, command execution, confirmation prompts, signal-safe shutdown and restart guidance.
- [x] Implement direct ENS resolver/contenthash reads with viem and retry transient RPC failures until CID match or `Ctrl+C`.
- [x] Re-run both release test files and verify they pass.

### Task 3: Package and documentation integration

**Files:**
- Modify: `package.json`
- Modify: `CLOUDFLARE.md`

**Interfaces:**
- Produces: `pnpm release`, `pnpm test:release`, documented production and recovery flows.

- [x] Add `release: "tsx scripts/release.ts"` and a focused `test:release` command running both release test files.
- [x] Document the wizard as the recommended production path, all supported flags, the manual ENS pause, strict `.env` secret synchronization, and the existing low-level commands.
- [x] Run `pnpm test:release` and verify all focused tests pass.

### Task 4: Targeted verification

**Files:**
- Verify only; no additional files expected.

**Interfaces:**
- Consumes: completed release wizard and documentation.
- Produces: evidence that the feature is type-safe, formatted and dry-run tested without external side effects.

- [x] Run `pnpm exec biome check scripts/release.ts scripts/release scripts/release-test.ts package.json CLOUDFLARE.md`.
- [x] Run `pnpm check` to verify TypeScript and repository checks.
- [x] Run `git diff --check` and inspect the final diff for secrets, automatic Git commits, automatic ENS mutation, or unrelated changes.
- [x] Confirm no real Filebase upload, Cloudflare deployment or ENS transaction occurred during tests.
