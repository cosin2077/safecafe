import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createReleaseOutputRedactor,
  decodeIpfsContenthash,
  parseReleaseArgs,
  type ReleaseSession,
  redactReleaseError,
  validateReleaseSession,
} from "./core"

const session: ReleaseSession = {
  version: 1,
  commit: "abc123",
  cid: "bafyrelease",
  uri: "ipfs://bafyrelease",
  cloudflareDeploymentUrl: null,
  stage: "ipfs_published",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
}

test("parseReleaseArgs returns production-safe defaults", () => {
  assert.deepEqual(parseReleaseArgs([]), {
    pollIntervalMs: 15_000,
    quick: false,
    resume: false,
    yes: false,
  })
})

test("parseReleaseArgs accepts supported flags", () => {
  assert.deepEqual(parseReleaseArgs(["--resume", "--yes", "--quick", "--poll-interval=7"]), {
    pollIntervalMs: 7_000,
    quick: true,
    resume: true,
    yes: true,
  })
})

test("parseReleaseArgs rejects unsafe or unknown values", () => {
  assert.throws(() => parseReleaseArgs(["--poll-interval=4"]), /at least 5 seconds/)
  assert.throws(() => parseReleaseArgs(["--poll-interval=abc"]), /whole number/)
  assert.throws(() => parseReleaseArgs(["--unknown"]), /Unknown release option/)
})

test("validateReleaseSession accepts the matching release commit", () => {
  assert.deepEqual(validateReleaseSession(session, "abc123"), session)
})

test("validateReleaseSession rejects stale or malformed sessions", () => {
  assert.throws(() => validateReleaseSession(session, "def456"), /belongs to commit abc123/)
  assert.throws(() => validateReleaseSession({ ...session, version: 2 }, "abc123"), /Unsupported release session/)
  assert.throws(() => validateReleaseSession({ ...session, stage: "unknown" }, "abc123"), /Invalid release session/)
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
