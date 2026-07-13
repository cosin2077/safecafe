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
  syncCloudflarePagesRuntimeSecrets,
  verifyFinalEndpoints,
  verifyIpfsGateways,
} from "./release.ts"

const defaultArgs: ReleaseArgs = {
  bump: "patch",
  pollIntervalMs: 5_000,
  quick: false,
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
    ensurePreflight: async () => {
      events.push("preflight")
    },
    getHead: async () => {
      events.push("head")
      return "abc123"
    },
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
  return { dependencies, events }
}

test("runReleaseWorkflow executes the complete release in order", async () => {
  const { dependencies, events } = createDependencies()

  const session = await runReleaseWorkflow(defaultArgs, dependencies)

  assert.ok(session)
  assert.deepEqual(events, [
    "prepare-version:patch",
    "head",
    "preflight",
    "confirm",
    "checks:full",
    "build",
    "publish-ipfs",
    "verify-ipfs",
    "deploy-cloudflare",
    "prompt-ens",
    "read-ens",
    "log:ens_mismatch",
    "sleep",
    "read-ens",
    "verify-final",
    "log:release_complete",
  ])
  assert.equal(session.stage, "verified")
  assert.equal(session.cloudflareDeploymentUrl, "https://abc.safecafe.pages.dev")
})

test("runReleaseWorkflow stops after preparing the next version", async () => {
  const { dependencies, events } = createDependencies({
    prepareVersion: async (bump) => {
      events.push(`prepare-version:${bump}`)
      return "0.1.1"
    },
  })

  const session = await runReleaseWorkflow({ ...defaultArgs, bump: "patch" }, dependencies)

  assert.equal(session, null)
  assert.deepEqual(events, ["prepare-version:patch", "log:version_prepared"])
})

test("runReleaseWorkflow stops when the build fails", async () => {
  const { dependencies } = createDependencies({
    build: async () => {
      throw new Error("build failed")
    },
  })

  await assert.rejects(() => runReleaseWorkflow(defaultArgs, dependencies), /build failed/)
})

test("ENS polling survives a transient RPC error", async () => {
  let attempts = 0
  const { dependencies, events } = createDependencies({
    readEnsCid: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("RPC timeout")
      return "bafyrelease"
    },
  })

  await runReleaseWorkflow({ ...defaultArgs, yes: true }, dependencies)

  assert.equal(events.includes("log:ens_check_error"), true)
  assert.equal(events.includes("sleep"), true)
  assert.equal(attempts, 2)
})

test("final endpoint verification retries while gateway caches settle", async () => {
  let attempts = 0
  const { dependencies, events } = createDependencies({
    readEnsCid: async () => "bafyrelease",
    verifyFinalRelease: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("eth.limo cache is stale")
    },
  })

  await runReleaseWorkflow({ ...defaultArgs, yes: true }, dependencies)

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

test("syncCloudflarePagesRuntimeSecrets lists, puts, and deletes known secrets when .env is authoritative", async () => {
  const commands: Array<{ args: string[]; input?: string }> = []
  await syncCloudflarePagesRuntimeSecrets({
    environment: {
      SAFECAFE_AUTH_SECRET: "new-auth-secret",
      SAFECAFE_LLM_API_KEY: "",
    },
    logSuccess: () => {},
    logWarning: () => {},
    projectName: "safecafe",
    releaseEnvFileFound: true,
    runCommand: async (_command, args, options = {}) => {
      commands.push({ args, input: options.input })
      if (args.includes("list")) {
        return [
          'The "production" environment of your Pages project "safecafe" has access to the following secrets:',
          "  - SAFECAFE_AUTH_SECRET: Value Encrypted",
          "  - SAFECAFE_LLM_API_KEY: Value Encrypted",
          "  - UNRELATED_SECRET: Value Encrypted",
        ].join("\n")
      }
      return ""
    },
    secrets: [],
  })

  assert.deepEqual(
    commands.map((item) => ({ args: item.args, input: item.input })),
    [
      {
        args: ["exec", "wrangler", "pages", "secret", "list", "--project-name", "safecafe"],
        input: undefined,
      },
      {
        args: ["exec", "wrangler", "pages", "secret", "put", "SAFECAFE_AUTH_SECRET", "--project-name", "safecafe"],
        input: "new-auth-secret\n",
      },
      {
        args: ["exec", "wrangler", "pages", "secret", "delete", "SAFECAFE_LLM_API_KEY", "--project-name", "safecafe"],
        input: "y\n",
      },
    ],
  )
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
