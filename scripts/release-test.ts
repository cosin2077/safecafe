import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import type { ReleaseArgs, ReleaseSession } from "./release/core"
import {
  extractCloudflareDeploymentUrl,
  type ReleaseWorkflowDependencies,
  runReleaseWorkflow,
  verifyFinalEndpoints,
  verifyIpfsGateways,
} from "./release.ts"

const defaultArgs: ReleaseArgs = {
  bump: "patch",
  pollIntervalMs: 5_000,
  quick: false,
  resume: false,
  yes: false,
}

const releaseRecord = {
  commit: "abc123",
  dirty: false,
  ipfs: {
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    gateways: {
      dweb: "https://bafyrelease.ipfs.dweb.link/",
      filebase: "https://ipfs.filebase.io/ipfs/bafyrelease/",
      ipfsIo: "https://ipfs.io/ipfs/bafyrelease/",
    },
  },
}

function createDependencies(overrides: Partial<ReleaseWorkflowDependencies> = {}) {
  const events: string[] = []
  const savedSessions: ReleaseSession[] = []
  const ensValues = ["bafyold", "bafyrelease"]
  const dependencies: ReleaseWorkflowDependencies = {
    build: async () => {
      events.push("build")
    },
    confirmRelease: async () => {
      events.push("confirm")
      return true
    },
    deployCloudflare: async () => {
      events.push("deploy-cloudflare")
      return "https://abc.safecafe.pages.dev"
    },
    ensurePreflight: async (resume) => {
      events.push(`preflight:${resume ? "resume" : "new"}`)
    },
    getHead: async () => {
      events.push("head")
      return "abc123"
    },
    loadSession: async () => null,
    log: (event) => events.push(`log:${event}`),
    now: () => "2026-07-11T00:00:00.000Z",
    prepareVersion: async (bump) => {
      events.push(`prepare-version:${bump}`)
      return null
    },
    promptForEnsUpdate: async () => {
      events.push("prompt-ens")
    },
    publishIpfs: async () => {
      events.push("publish-ipfs")
      return releaseRecord
    },
    readEnsCid: async () => {
      events.push("read-ens")
      return ensValues.shift() ?? "bafyrelease"
    },
    runChecks: async (quick) => {
      events.push(`checks:${quick ? "quick" : "full"}`)
    },
    saveSession: async (session) => {
      savedSessions.push(structuredClone(session))
      events.push(`save:${session.stage}`)
    },
    sleep: async () => {
      events.push("sleep")
    },
    verifyFinalRelease: async () => {
      events.push("verify-final")
    },
    verifyIpfsRelease: async () => {
      events.push("verify-ipfs")
    },
    ...overrides,
  }
  return { dependencies, events, savedSessions }
}

test("runReleaseWorkflow executes the complete release in order", async () => {
  const { dependencies, events, savedSessions } = createDependencies()

  const session = await runReleaseWorkflow(defaultArgs, dependencies)

  assert.ok(session)
  assert.deepEqual(events, [
    "prepare-version:patch",
    "head",
    "preflight:new",
    "confirm",
    "checks:full",
    "build",
    "publish-ipfs",
    "save:ipfs_published",
    "verify-ipfs",
    "deploy-cloudflare",
    "save:cloudflare_deployed",
    "prompt-ens",
    "save:awaiting_ens",
    "read-ens",
    "log:ens_mismatch",
    "sleep",
    "read-ens",
    "verify-final",
    "save:verified",
    "log:release_complete",
  ])
  assert.equal(session.stage, "verified")
  assert.equal(session.cloudflareDeploymentUrl, "https://abc.safecafe.pages.dev")
  assert.deepEqual(
    savedSessions.map((item) => item.stage),
    ["ipfs_published", "cloudflare_deployed", "awaiting_ens", "verified"],
  )
})

test("runReleaseWorkflow stops after preparing the next version", async () => {
  const { dependencies, events, savedSessions } = createDependencies({
    prepareVersion: async (bump) => {
      events.push(`prepare-version:${bump}`)
      return "0.1.1"
    },
  })

  const session = await runReleaseWorkflow({ ...defaultArgs, bump: "patch" }, dependencies)

  assert.equal(session, null)
  assert.deepEqual(events, ["prepare-version:patch", "log:version_prepared"])
  assert.equal(savedSessions.length, 0)
})

test("runReleaseWorkflow does not create a session before IPFS succeeds", async () => {
  const { dependencies, savedSessions } = createDependencies({
    build: async () => {
      throw new Error("build failed")
    },
  })

  await assert.rejects(() => runReleaseWorkflow(defaultArgs, dependencies), /build failed/)
  assert.equal(savedSessions.length, 0)
})

test("runReleaseWorkflow preserves the session after IPFS succeeds", async () => {
  const { dependencies, savedSessions } = createDependencies({
    verifyIpfsRelease: async () => {
      throw new Error("gateway unavailable")
    },
  })

  await assert.rejects(() => runReleaseWorkflow({ ...defaultArgs, yes: true }, dependencies), /gateway unavailable/)
  assert.deepEqual(
    savedSessions.map((item) => item.stage),
    ["ipfs_published"],
  )
})

test("resume skips completed work and retries an unfinished Cloudflare deploy", async () => {
  const existingSession: ReleaseSession = {
    version: 1,
    commit: "abc123",
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    cloudflareDeploymentUrl: null,
    stage: "ipfs_published",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  }
  const { dependencies, events } = createDependencies({
    loadSession: async () => existingSession,
    readEnsCid: async () => "bafyrelease",
  })

  await runReleaseWorkflow({ ...defaultArgs, resume: true }, dependencies)

  assert.equal(events.includes("prepare-version:patch"), false)
  assert.equal(events.includes("checks:full"), false)
  assert.equal(events.includes("build"), false)
  assert.equal(events.includes("publish-ipfs"), false)
  assert.equal(events.includes("verify-ipfs"), true)
  assert.equal(events.includes("deploy-cloudflare"), true)
})

test("resume from the ENS stage does not redeploy", async () => {
  const existingSession: ReleaseSession = {
    version: 1,
    commit: "abc123",
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    cloudflareDeploymentUrl: "https://abc.safecafe.pages.dev",
    stage: "awaiting_ens",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  }
  const { dependencies, events } = createDependencies({
    loadSession: async () => existingSession,
    readEnsCid: async () => "bafyrelease",
  })

  await runReleaseWorkflow({ ...defaultArgs, resume: true }, dependencies)

  assert.equal(events.includes("verify-ipfs"), false)
  assert.equal(events.includes("deploy-cloudflare"), false)
  assert.equal(events.includes("prompt-ens"), true)
  assert.equal(events.includes("verify-final"), true)
})

test("ENS polling survives a transient RPC error", async () => {
  const existingSession: ReleaseSession = {
    version: 1,
    commit: "abc123",
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    cloudflareDeploymentUrl: "https://abc.safecafe.pages.dev",
    stage: "awaiting_ens",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  }
  let attempts = 0
  const { dependencies, events } = createDependencies({
    loadSession: async () => existingSession,
    readEnsCid: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("RPC timeout")
      return "bafyrelease"
    },
  })

  await runReleaseWorkflow({ ...defaultArgs, resume: true }, dependencies)

  assert.equal(events.includes("log:ens_check_error"), true)
  assert.equal(events.includes("sleep"), true)
  assert.equal(attempts, 2)
})

test("final endpoint verification retries while gateway caches settle", async () => {
  const existingSession: ReleaseSession = {
    version: 1,
    commit: "abc123",
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    cloudflareDeploymentUrl: "https://abc.safecafe.pages.dev",
    stage: "awaiting_ens",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  }
  let attempts = 0
  const { dependencies, events } = createDependencies({
    loadSession: async () => existingSession,
    readEnsCid: async () => "bafyrelease",
    verifyFinalRelease: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("eth.limo cache is stale")
    },
  })

  await runReleaseWorkflow({ ...defaultArgs, resume: true }, dependencies)

  assert.equal(events.includes("log:final_check_error"), true)
  assert.equal(events.includes("sleep"), true)
  assert.equal(attempts, 2)
})

test("extractCloudflareDeploymentUrl reads the Wrangler deployment URL", () => {
  const output = ["Uploading...", "Deployment complete! Take a peek over at https://8f20a1c2.safecafe.pages.dev"].join(
    "\n",
  )
  assert.equal(extractCloudflareDeploymentUrl(output), "https://8f20a1c2.safecafe.pages.dev")
  assert.throws(() => extractCloudflareDeploymentUrl("Deployment complete without URL"), /deployment URL/)
})

test("verifyIpfsGateways checks index and manifest through two gateways", async () => {
  const requested: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith("release-manifest.json")) {
      return Response.json({ commit: "abc123", dirty: false })
    }
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } })
  }

  await verifyIpfsGateways(releaseRecord, fetcher)

  assert.deepEqual(requested, [
    "https://ipfs.filebase.io/ipfs/bafyrelease/",
    "https://ipfs.filebase.io/ipfs/bafyrelease/release-manifest.json",
    "https://bafyrelease.ipfs.dweb.link/",
    "https://bafyrelease.ipfs.dweb.link/release-manifest.json",
  ])
})

test("verifyIpfsGateways rejects a manifest from another commit", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("release-manifest.json")) {
      return Response.json({ commit: "other", dirty: false })
    }
    return new Response("ok")
  }
  await assert.rejects(() => verifyIpfsGateways(releaseRecord, fetcher), /manifest commit/)
})

test("verifyFinalEndpoints matches Cloudflare and eth.limo to the release CID", async () => {
  const verifiedSession: ReleaseSession = {
    version: 1,
    commit: "abc123",
    cid: "bafyrelease",
    uri: "ipfs://bafyrelease",
    cloudflareDeploymentUrl: "https://abc.safecafe.pages.dev",
    stage: "awaiting_ens",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  }
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("release-record.json")) return Response.json(releaseRecord)
    return new Response("ok", { headers: { "x-ipfs-roots": "bafyrelease" } })
  }

  await verifyFinalEndpoints(verifiedSession, fetcher)
})

test("release CLI prepares and synchronizes the next version before deployment", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "safecafe-release-version-"))
  try {
    await mkdir(join(fixtureRoot, "packages/safe-lite"), { recursive: true })
    await mkdir(join(fixtureRoot, "releases/ipfs"), { recursive: true })
    await mkdir(join(fixtureRoot, "src/shared"), { recursive: true })
    await writeFile(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ name: "safecafe", version: "0.1.0" }, null, 2)}\n`,
    )
    await writeFile(
      join(fixtureRoot, "packages/safe-lite/package.json"),
      `${JSON.stringify({ name: "@safecafe/safe-lite", version: "0.1.0" }, null, 2)}\n`,
    )
    await writeFile(join(fixtureRoot, "releases/ipfs/latest.json"), `${JSON.stringify({ version: "0.1.0" })}\n`)
    await writeFile(join(fixtureRoot, "src/shared/version.ts"), 'export const SAFECAFE_VERSION = "0.1.0"\n')
    runFixtureGit(fixtureRoot, ["init", "--quiet"])
    runFixtureGit(fixtureRoot, ["config", "user.email", "release-test@safecafe.local"])
    runFixtureGit(fixtureRoot, ["config", "user.name", "Safecafe Release Test"])
    runFixtureGit(fixtureRoot, ["add", "."])
    runFixtureGit(fixtureRoot, ["commit", "--quiet", "-m", "fixture"])

    const result = spawnSync(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/release.ts"), "--bump=minor"],
      { cwd: fixtureRoot, encoding: "utf8" },
    )

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(JSON.parse(await readFile(join(fixtureRoot, "package.json"), "utf8")).version, "0.2.0")
    assert.equal(
      JSON.parse(await readFile(join(fixtureRoot, "packages/safe-lite/package.json"), "utf8")).version,
      "0.2.0",
    )
    assert.equal(
      await readFile(join(fixtureRoot, "src/shared/version.ts"), "utf8"),
      'export const SAFECAFE_VERSION = "0.2.0"\n',
    )
    await assert.rejects(() => readFile(join(fixtureRoot, "dist/release-session.json")), /ENOENT/)
    assert.match(result.stdout, /已准备发布版本 0\.2\.0/)
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true })
  }
})

test("release CLI renders argument errors without an unhandled exception", () => {
  const result = spawnSync("pnpm", ["exec", "tsx", "scripts/release.ts", "--unknown"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
  const output = `${result.stdout}\n${result.stderr}`

  assert.equal(result.status, 1)
  assert.match(output, /发布失败/)
  assert.equal(output.includes("triggerUncaughtException"), false)
})

function runFixtureGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}
