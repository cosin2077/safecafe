import assert from "node:assert/strict"
import { test } from "node:test"
import {
  collectCloudflarePagesSecrets,
  createReleaseOutputRedactor,
  decodeIpfsContenthash,
  extractCloudflarePagesSecretNames,
  parseReleaseArgs,
  planCloudflarePagesSecretSync,
  planReleaseVersion,
  redactReleaseError,
  renderSafecafeVersionModule,
} from "./core"

test("parseReleaseArgs returns production-safe defaults", () => {
  assert.deepEqual(parseReleaseArgs([]), {
    bump: "patch",
    pollIntervalMs: 15_000,
    quick: false,
    yes: false,
  })
})

test("parseReleaseArgs accepts supported flags", () => {
  assert.deepEqual(parseReleaseArgs(["--yes", "--quick", "--bump=minor", "--poll-interval=7"]), {
    bump: "minor",
    pollIntervalMs: 7_000,
    quick: true,
    yes: true,
  })
})

test("parseReleaseArgs rejects unsafe or unknown values", () => {
  assert.throws(() => parseReleaseArgs(["--poll-interval=4"]), /at least 5 seconds/)
  assert.throws(() => parseReleaseArgs(["--poll-interval=abc"]), /whole number/)
  assert.throws(() => parseReleaseArgs(["--bump=banana"]), /Version bump/)
  assert.throws(() => parseReleaseArgs(["--resume"]), /Unknown release option/)
  assert.throws(() => parseReleaseArgs(["--unknown"]), /Unknown release option/)
})

test("planReleaseVersion prepares the requested bump when the current version is already published", () => {
  assert.deepEqual(planReleaseVersion("0.1.0", "0.1.0", "patch"), {
    action: "prepare",
    currentVersion: "0.1.0",
    nextVersion: "0.1.1",
  })
  assert.deepEqual(planReleaseVersion("0.1.0", "0.1.0", "minor"), {
    action: "prepare",
    currentVersion: "0.1.0",
    nextVersion: "0.2.0",
  })
  assert.deepEqual(planReleaseVersion("0.1.0", "0.1.0", "major"), {
    action: "prepare",
    currentVersion: "0.1.0",
    nextVersion: "1.0.0",
  })
})

test("planReleaseVersion publishes a new version and rejects version rollback", () => {
  assert.deepEqual(planReleaseVersion("0.1.1", "0.1.0", "patch"), {
    action: "release",
    version: "0.1.1",
  })
  assert.deepEqual(planReleaseVersion("0.1.0", null, "patch"), {
    action: "release",
    version: "0.1.0",
  })
  assert.throws(() => planReleaseVersion("0.1.0", "0.1.1", "patch"), /behind latest release/)
  assert.throws(() => planReleaseVersion("latest", "0.1.0", "patch"), /valid semantic version/)
})

test("renderSafecafeVersionModule keeps the UI version synchronized", () => {
  assert.equal(renderSafecafeVersionModule("0.1.1"), 'export const SAFECAFE_VERSION = "0.1.1"\n')
})

test("collectCloudflarePagesSecrets returns only deploy runtime secrets", () => {
  const secrets = collectCloudflarePagesSecrets({
    FILEBASE_ACCESS_TOKEN: "filebase-secret",
    SAFECAFE_API_ALLOWED_ORIGINS: "https://safe-staking.eth.limo,https://safecafe.baserun.link",
    SAFECAFE_CLI_PRIVATE_KEY: "0xprivate",
    SAFECAFE_LLM_API_KEY: "llm-secret",
    SAFECAFE_SAFE_API_KEYS: "safe-secret",
    SAFECAFE_AGENT_TEST_VERIFIED_ACCESS: "true",
    SAFECAFE_TRUST_PROXY_HEADERS: "true",
    VITE_AGENT_AUTH: "true",
  })
  assert.deepEqual(
    secrets.map((entry) => entry.name),
    [
      "SAFECAFE_API_ALLOWED_ORIGINS",
      "SAFECAFE_TRUST_PROXY_HEADERS",
      "SAFECAFE_SAFE_API_KEYS",
      "SAFECAFE_LLM_API_KEY",
      "VITE_AGENT_AUTH",
    ],
  )
})

test("strict Cloudflare secret sync deletes only known secrets omitted from .env", () => {
  const plan = planCloudflarePagesSecretSync(
    {
      SAFECAFE_AUTH_SECRET: "new-auth-secret",
      SAFECAFE_LLM_API_KEY: "",
    },
    ["SAFECAFE_AUTH_SECRET", "SAFECAFE_LLM_API_KEY", "UNRELATED_SECRET"],
    true,
  )

  assert.deepEqual(plan.put, [{ name: "SAFECAFE_AUTH_SECRET", value: "new-auth-secret" }])
  assert.deepEqual(plan.delete, ["SAFECAFE_LLM_API_KEY"])
})

test("non-strict Cloudflare secret sync never deletes missing shell values", () => {
  const plan = planCloudflarePagesSecretSync({}, ["SAFECAFE_LLM_API_KEY"], false)
  assert.deepEqual(plan, { delete: [], put: [] })
})

test("extractCloudflarePagesSecretNames reads Wrangler output", () => {
  assert.deepEqual(
    extractCloudflarePagesSecretNames(`
The production environment has access to the following secrets:
  - SAFECAFE_AUTH_SECRET: Value Encrypted
  - SAFECAFE_LLM_API_KEY: Value Encrypted
`),
    ["SAFECAFE_AUTH_SECRET", "SAFECAFE_LLM_API_KEY"],
  )
})

test("decodeIpfsContenthash decodes the IPFS namespace and rejects other namespaces", () => {
  assert.equal(decodeIpfsContenthash("0xe30100"), "baa")
  assert.equal(decodeIpfsContenthash("0x900100"), null)
  assert.equal(decodeIpfsContenthash("0x"), null)
  assert.equal(decodeIpfsContenthash("not-hex"), null)
})

test("redactReleaseError removes supplied and common credential values", () => {
  const secret = "filebase-secret-value"
  const value = [
    `upload failed secret=${secret}`,
    "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "apiKey=sk-live-abcdef1234567890",
  ].join("\n")
  const redacted = redactReleaseError(value, [secret])

  assert.equal(redacted.includes(secret), false)
  assert.equal(redacted.includes("eyJhbGci"), false)
  assert.equal(redacted.includes("sk-live"), false)
  assert.match(redacted, /\[REDACTED\]/)
})

test("createReleaseOutputRedactor protects secrets split across output chunks", () => {
  const secret = "filebase-secret-value"
  const emitted: string[] = []
  const redactor = createReleaseOutputRedactor([secret], (value) => emitted.push(value))

  redactor.write("upload token=filebase-")
  redactor.write("secret-value\nnext line")
  redactor.flush()

  const output = emitted.join("")
  assert.equal(output.includes(secret), false)
  assert.match(output, /token=\[REDACTED\]/)
  assert.match(output, /next line/)
})
