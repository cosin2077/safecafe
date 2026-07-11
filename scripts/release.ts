import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { createPublicClient, fallback, type Hex, http } from "viem"
import { mainnet } from "viem/chains"
import { namehash, normalize } from "viem/ens"
import { DEFAULT_RPC_URLS } from "../src/protocol/contracts"
import {
  cloudflarePagesRuntimeSecretNames,
  collectCloudflarePagesSecrets,
  createReleaseOutputRedactor,
  decodeIpfsContenthash,
  parseReleaseArgs,
  planReleaseVersion,
  type ReleaseArgs,
  type ReleaseSession,
  type ReleaseVersionBump,
  redactReleaseError,
  renderSafecafeVersionModule,
  validateReleaseSession,
} from "./release/core"

const projectName = "safecafe"
const ensName = "safe-staking.eth"
const ensManagerUrl = `https://app.ens.domains/${ensName}`
const sessionPath = resolve("dist/release-session.json")
const releaseRecordPath = resolve("dist/release-record.json")
const packageJsonPath = resolve("package.json")
const safeLitePackageJsonPath = resolve("packages/safe-lite/package.json")
const uiVersionPath = resolve("src/shared/version.ts")
const latestReleaseRecordPaths = [resolve("releases/ipfs/latest.json"), resolve("public/release-record.json")]
let releaseEnvFileFound = false
const contenthashAbi = [
  {
    inputs: [{ name: "node", type: "bytes32" }],
    name: "contenthash",
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const

export type IpfsReleaseRecord = {
  commit: string
  dirty: boolean
  ipfs: {
    cid: string
    uri: string
    gateways: {
      dweb?: string
      filebase?: string
      ipfsIo?: string
    }
  }
}

export type ReleaseWorkflowEvent =
  | "ens_check_error"
  | "ens_mismatch"
  | "final_check_error"
  | "release_complete"
  | "version_prepared"

export type ReleaseWorkflowDependencies = {
  build: () => Promise<void>
  confirmRelease: () => Promise<boolean>
  deployCloudflare: () => Promise<string>
  ensurePreflight: (resume: boolean) => Promise<void>
  getHead: () => Promise<string>
  loadSession: () => Promise<ReleaseSession | null>
  log: (event: ReleaseWorkflowEvent, details?: Record<string, string>) => void
  now: () => string
  prepareVersion: (bump: ReleaseVersionBump) => Promise<string | null>
  promptForEnsUpdate: (session: ReleaseSession) => Promise<void>
  publishIpfs: () => Promise<IpfsReleaseRecord>
  readEnsCid: () => Promise<string | null>
  runChecks: (quick: boolean) => Promise<void>
  saveSession: (session: ReleaseSession) => Promise<void>
  sleep: (milliseconds: number) => Promise<void>
  verifyFinalRelease: (session: ReleaseSession) => Promise<void>
  verifyIpfsRelease: (session: ReleaseSession) => Promise<void>
}

export async function runReleaseWorkflow(
  args: ReleaseArgs,
  dependencies: ReleaseWorkflowDependencies,
): Promise<ReleaseSession | null> {
  if (!args.resume) {
    const preparedVersion = await dependencies.prepareVersion(args.bump)
    if (preparedVersion) {
      dependencies.log("version_prepared", { version: preparedVersion })
      return null
    }
  }

  const head = await dependencies.getHead()
  await dependencies.ensurePreflight(args.resume)

  let session: ReleaseSession
  if (args.resume) {
    const savedSession = await dependencies.loadSession()
    if (!savedSession) throw new Error("No resumable release session was found.")
    session = validateReleaseSession(savedSession, head)
  } else {
    if (!args.yes && !(await dependencies.confirmRelease())) throw new Error("Release cancelled by user.")
    await dependencies.runChecks(args.quick)
    await dependencies.build()
    const record = await dependencies.publishIpfs()
    validatePublishedRecord(record, head)
    const timestamp = dependencies.now()
    session = {
      version: 1,
      commit: record.commit,
      cid: record.ipfs.cid,
      uri: record.ipfs.uri,
      cloudflareDeploymentUrl: null,
      stage: "ipfs_published",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await dependencies.saveSession(session)
  }

  if (session.stage === "verified") {
    dependencies.log("release_complete")
    return session
  }

  if (session.stage === "ipfs_published") {
    await dependencies.verifyIpfsRelease(session)
    const deploymentUrl = await dependencies.deployCloudflare()
    session = updateSession(session, dependencies.now(), {
      cloudflareDeploymentUrl: deploymentUrl,
      stage: "cloudflare_deployed",
    })
    await dependencies.saveSession(session)
  }

  if (session.stage === "cloudflare_deployed" || session.stage === "awaiting_ens") {
    await dependencies.promptForEnsUpdate(session)
    session = updateSession(session, dependencies.now(), { stage: "awaiting_ens" })
    await dependencies.saveSession(session)
  }

  while (true) {
    try {
      const currentCid = await dependencies.readEnsCid()
      if (currentCid?.toLowerCase() === session.cid.toLowerCase()) break
      dependencies.log("ens_mismatch", {
        currentCid: currentCid ?? "not available",
        targetCid: session.cid,
      })
    } catch (error) {
      dependencies.log("ens_check_error", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await dependencies.sleep(args.pollIntervalMs)
  }

  while (true) {
    try {
      await dependencies.verifyFinalRelease(session)
      break
    } catch (error) {
      dependencies.log("final_check_error", {
        error: error instanceof Error ? error.message : String(error),
      })
      await dependencies.sleep(args.pollIntervalMs)
    }
  }
  session = updateSession(session, dependencies.now(), { stage: "verified" })
  await dependencies.saveSession(session)
  dependencies.log("release_complete")
  return session
}

export function extractCloudflareDeploymentUrl(output: string): string {
  const urls = output.match(/https:\/\/[A-Za-z0-9.-]+\.pages\.dev\/?/g) ?? []
  const deploymentUrl = urls.at(-1)?.replace(/\/$/, "")
  if (!deploymentUrl) throw new Error("Wrangler did not report a Cloudflare Pages deployment URL.")
  return deploymentUrl
}

export async function verifyIpfsGateways(record: IpfsReleaseRecord, fetcher: typeof fetch): Promise<void> {
  const gateways = [record.ipfs.gateways.filebase, record.ipfs.gateways.dweb].filter((value): value is string =>
    Boolean(value),
  )
  if (gateways.length < 2) throw new Error("Release record must provide at least two IPFS gateways.")

  for (const gateway of gateways.slice(0, 2)) {
    const rootResponse = await fetcher(ensureTrailingSlash(gateway), { cache: "no-store" })
    if (!rootResponse.ok) throw new Error(`IPFS gateway returned HTTP ${rootResponse.status}: ${gateway}`)
    const manifestUrl = `${ensureTrailingSlash(gateway)}release-manifest.json`
    const manifestResponse = await fetcher(manifestUrl, { cache: "no-store" })
    if (!manifestResponse.ok) {
      throw new Error(`IPFS manifest returned HTTP ${manifestResponse.status}: ${manifestUrl}`)
    }
    const manifest = (await manifestResponse.json()) as { commit?: unknown; dirty?: unknown }
    if (manifest.commit !== record.commit) {
      throw new Error(`IPFS manifest commit ${String(manifest.commit)} does not match ${record.commit}.`)
    }
    if (manifest.dirty === true) throw new Error(`IPFS manifest is marked dirty: ${manifestUrl}`)
  }
}

export async function verifyFinalEndpoints(session: ReleaseSession, fetcher: typeof fetch): Promise<void> {
  if (!session.cloudflareDeploymentUrl)
    throw new Error("Cloudflare deployment URL is missing from the release session.")
  const recordUrl = `${ensureTrailingSlash(session.cloudflareDeploymentUrl)}release-record.json`
  const recordResponse = await fetcher(recordUrl, { cache: "no-store" })
  if (!recordResponse.ok) {
    throw new Error(`Cloudflare release record returned HTTP ${recordResponse.status}: ${recordUrl}`)
  }
  const record = (await recordResponse.json()) as { ipfs?: { cid?: unknown } }
  if (record.ipfs?.cid !== session.cid) {
    throw new Error(`Cloudflare release record CID ${String(record.ipfs?.cid)} does not match ${session.cid}.`)
  }

  const ensGatewayResponse = await fetcher("https://safe-staking.eth.limo/", {
    cache: "no-store",
    method: "HEAD",
  })
  if (!ensGatewayResponse.ok) {
    throw new Error(`ENS/IPFS gateway returned HTTP ${ensGatewayResponse.status}.`)
  }
  const roots = ensGatewayResponse.headers.get("x-ipfs-roots") ?? ensGatewayResponse.headers.get("x-ipfs-path") ?? ""
  if (!roots.toLowerCase().includes(session.cid.toLowerCase())) {
    throw new Error(`ENS/IPFS gateway root does not match ${session.cid}.`)
  }
}

function validatePublishedRecord(record: IpfsReleaseRecord, head: string) {
  if (record.commit !== head) {
    throw new Error(`Published record commit ${record.commit} does not match current HEAD ${head}.`)
  }
  if (record.dirty) throw new Error("Published release record is marked as dirty.")
  if (!record.ipfs?.cid || record.ipfs.uri !== `ipfs://${record.ipfs.cid}`) {
    throw new Error("Published release record does not contain a valid IPFS CID.")
  }
}

function updateSession(
  session: ReleaseSession,
  updatedAt: string,
  update: Partial<Pick<ReleaseSession, "cloudflareDeploymentUrl" | "stage">>,
): ReleaseSession {
  return {
    ...session,
    ...update,
    updatedAt,
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

type CommandOptions = {
  input?: string
  quiet?: boolean
  secrets?: string[]
}

type ReleaseLogger = ReturnType<typeof createReleaseLogger>

async function main() {
  const logger = createReleaseLogger()
  let prompt: ReturnType<typeof createInterface> | null = null
  let secrets: string[] = []
  logger.banner()
  try {
    const args = parseReleaseArgs(process.argv.slice(2))
    const environment = await loadEnvironment()
    applyEnvironment(environment)
    secrets = collectSecrets(environment)
    const releasePrompt = createInterface({ input: process.stdin, output: process.stdout })
    prompt = releasePrompt
    const client = createEnsClient(environment)
    let branch = "unknown"
    let currentHead = ""

    process.once("SIGINT", () => {
      logger.warning("发布已取消。已完成的发布会话会保留，可使用 pnpm release --resume 继续。")
      releasePrompt.close()
      process.exit(130)
    })

    const dependencies: ReleaseWorkflowDependencies = {
      prepareVersion: async (bump) => {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>
        if (packageJson.name !== "safecafe" || typeof packageJson.version !== "string") {
          throw new Error("Run the release wizard from the Safecafe repository root.")
        }
        const safeLitePackageJson = JSON.parse(await readFile(safeLitePackageJsonPath, "utf8")) as Record<
          string,
          unknown
        >
        if (safeLitePackageJson.name !== "@safecafe/safe-lite" || typeof safeLitePackageJson.version !== "string") {
          throw new Error("Invalid packages/safe-lite/package.json release metadata.")
        }
        const status = (await runCommand("git", ["status", "--short"], { quiet: true, secrets })).trim()
        if (status) throw new Error(`Git worktree must be clean before preparing a release version.\n${status}`)

        const latestVersion = await readLatestReleaseVersion()
        const plan = planReleaseVersion(packageJson.version, latestVersion, bump)
        const targetVersion = plan.action === "prepare" ? plan.nextVersion : plan.version
        const expectedVersionModule = renderSafecafeVersionModule(targetVersion)
        const currentVersionModule = await readFile(uiVersionPath, "utf8")
        const packageNeedsUpdate = plan.action === "prepare"
        const safeLiteNeedsUpdate = safeLitePackageJson.version !== targetVersion
        const uiNeedsUpdate = currentVersionModule !== expectedVersionModule

        if (!packageNeedsUpdate && !safeLiteNeedsUpdate && !uiNeedsUpdate) {
          logger.success(
            latestVersion
              ? `发布版本 ${targetVersion} 已高于线上版本 ${latestVersion}`
              : `首个发布版本使用 ${targetVersion}`,
          )
          return null
        }

        if (packageNeedsUpdate) {
          packageJson.version = targetVersion
          await writeJsonAtomic(packageJsonPath, packageJson)
        }
        if (safeLiteNeedsUpdate) {
          safeLitePackageJson.version = targetVersion
          await writeJsonAtomic(safeLitePackageJsonPath, safeLitePackageJson)
        }
        if (uiNeedsUpdate) await writeTextAtomic(uiVersionPath, expectedVersionModule)
        return targetVersion
      },
      getHead: async () => {
        currentHead = (await runCommand("git", ["rev-parse", "HEAD"], { quiet: true, secrets })).trim()
        return currentHead
      },
      ensurePreflight: async (resume) => {
        logger.section("发布前检查")
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown }
        if (packageJson.name !== "safecafe")
          throw new Error("Run the release wizard from the Safecafe repository root.")
        branch =
          (await runCommand("git", ["branch", "--show-current"], { quiet: true, secrets })).trim() || "detached HEAD"
        const status = (await runCommand("git", ["status", "--short"], { quiet: true, secrets })).trim()
        if (!resume && status) {
          throw new Error(`Git worktree must be clean before a new release.\n${status}`)
        }
        await runCommand("pnpm", ["--version"], { quiet: true, secrets })
        await runCommand("pnpm", ["exec", "wrangler", "whoami"], { quiet: true, secrets })
        if (!resume) assertRequiredEnvironment(environment)
        logger.success(resume ? "恢复会话检查通过" : "Git、pnpm、Wrangler 和 Filebase 配置检查通过")
        logger.keyValue("分支", branch)
        logger.keyValue("Commit", currentHead)
        logger.keyValue("Cloudflare 项目", projectName)
        logger.keyValue("ENS", ensName)
        logger.keyValue(
          "环境来源",
          releaseEnvFileFound ? ".env 发布配置优先，缺失项不从 shell 继承" : "未找到 .env，使用当前 shell 环境",
        )
        logger.keyValue(
          "前端 API Base",
          environment.VITE_API_BASE_URL?.trim() || "same-origin / static hosted fallback",
        )
        logger.keyValue("前端 Agent Auth", environment.VITE_AGENT_AUTH?.trim() || "default")
      },
      confirmRelease: async () => {
        const answer = await releasePrompt.question("\n确认开始生产发布？输入 yes 继续: ")
        return answer.trim().toLowerCase() === "yes"
      },
      runChecks: async (quick) => {
        logger.section(quick ? "快速发布检查" : "完整发布检查")
        await runLoggedCommand(logger, "代码与类型检查", "pnpm", ["check"], secrets)
        if (!quick) {
          await runLoggedCommand(logger, "Staking Agent 测试", "pnpm", ["test:agent"], secrets)
          await runLoggedCommand(logger, "集成测试", "pnpm", ["test:integration"], secrets)
        }
      },
      build: async () => {
        logger.section("构建发布产物")
        if (args.quick) {
          await runLoggedCommand(logger, "Web 生产构建", "pnpm", ["build:web"], secrets)
        } else {
          await runLoggedCommand(logger, "Web 与 CLI 生产构建", "pnpm", ["build"], secrets)
          await runLoggedCommand(logger, "系统测试", "node", ["scripts/system-test.mjs"], secrets)
        }
      },
      publishIpfs: async () => {
        logger.section("发布 Filebase / IPFS")
        await runLoggedCommand(
          logger,
          "上传同一份 dist 构建",
          "node",
          ["scripts/publish-ipfs.mjs", "--skip-build"],
          secrets,
        )
        const record = JSON.parse(await readFile(releaseRecordPath, "utf8")) as IpfsReleaseRecord
        logger.success(`IPFS 发布完成: ${record.ipfs?.uri ?? "release record unavailable"}`)
        return record
      },
      verifyIpfsRelease: async (session) => {
        logger.section("验证 IPFS 网关")
        const record = JSON.parse(await readFile(releaseRecordPath, "utf8")) as IpfsReleaseRecord
        if (record.ipfs.cid !== session.cid)
          throw new Error("dist/release-record.json does not match the release session.")
        await verifyIpfsGateways(record, fetchWithTimeout)
        logger.success("Filebase 与 dweb.link 的页面和发布清单均可访问")
      },
      deployCloudflare: async () => {
        logger.section("同步 Cloudflare Pages 服务端配置")
        const runtimeSecrets = collectCloudflarePagesSecrets(environment)
        const emptyRuntimeSecrets = cloudflarePagesRuntimeSecretNames.filter((name) => !environment[name]?.trim())
        if (runtimeSecrets.length) {
          logger.info(`以 .env / shell 环境为准，同步 ${runtimeSecrets.length} 个非空 runtime 配置`)
        }
        for (const { name, value } of runtimeSecrets) {
          await runCommand(
            "pnpm",
            ["exec", "wrangler", "pages", "secret", "put", name, "--project-name", projectName],
            { input: `${value}\n`, secrets },
          )
          logger.success(`已同步 ${name}`)
        }
        if (runtimeSecrets.length === 0) logger.warning("未发现可同步的 Cloudflare runtime 配置")
        if (emptyRuntimeSecrets.length) {
          logger.warning(
            `以下 runtime 配置为空，release 不会删除 Cloudflare 线上旧值: ${emptyRuntimeSecrets.join(", ")}`,
          )
        }

        logger.section("部署 Cloudflare Pages")
        const output = await runCommand(
          "pnpm",
          ["exec", "wrangler", "pages", "deploy", "dist", "--project-name", projectName, "--commit-dirty=true"],
          { secrets },
        )
        const deploymentUrl = extractCloudflareDeploymentUrl(output)
        logger.success(`Cloudflare 部署完成: ${deploymentUrl}`)
        return deploymentUrl
      },
      promptForEnsUpdate: async (session) => {
        logger.manualAction(session.uri, ensManagerUrl)
        await releasePrompt.question("完成 ENS 交易并确认上链后，按 Enter 开始持续检查...")
        logger.info(`每 ${args.pollIntervalMs / 1_000} 秒检查一次 ENS contenthash，Ctrl+C 可安全退出。`)
      },
      readEnsCid: async () => {
        const normalizedName = normalize(ensName)
        const resolverAddress = await client.getEnsResolver({ name: normalizedName })
        if (!resolverAddress) return null
        const contenthash = (await client.readContract({
          abi: contenthashAbi,
          address: resolverAddress,
          args: [namehash(normalizedName)],
          functionName: "contenthash",
        })) as Hex
        return decodeIpfsContenthash(contenthash)
      },
      verifyFinalRelease: async (session) => {
        logger.info("ENS 已匹配，正在等待 Cloudflare 与 eth.limo 端点同步...")
        await verifyFinalEndpoints(session, fetchWithTimeout)
      },
      loadSession: async () => {
        try {
          return JSON.parse(await readFile(sessionPath, "utf8")) as ReleaseSession
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return null
          throw error
        }
      },
      saveSession: async (session) => {
        await writeJsonAtomic(sessionPath, session)
      },
      sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
      now: () => new Date().toISOString(),
      log: (event, details) => {
        if (event === "ens_mismatch") {
          logger.warning(`ENS 尚未更新。当前: ${details?.currentCid}; 目标: ${details?.targetCid}`)
        } else if (event === "ens_check_error") {
          logger.warning(`ENS 查询暂时失败，将继续重试: ${redactReleaseError(details?.error ?? "unknown", secrets)}`)
        } else if (event === "final_check_error") {
          logger.warning(`线上端点尚未同步，将继续重试: ${redactReleaseError(details?.error ?? "unknown", secrets)}`)
        } else if (event === "version_prepared") {
          logger.versionPrepared(details?.version ?? "unknown")
        } else {
          logger.complete(sessionPath)
        }
      },
    }

    await runReleaseWorkflow(args, dependencies)
  } catch (error) {
    logger.failure(redactReleaseError(error, secrets))
    if (await fileExists(sessionPath)) logger.info("恢复命令: pnpm release --resume")
    process.exitCode = 1
  } finally {
    prompt?.close()
  }
}

function createReleaseLogger() {
  const colorsEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)
  let section = 0
  const paint = (code: number, value: string) => (colorsEnabled ? `\u001b[${code}m${value}\u001b[0m` : value)
  const line = (value = "") => process.stdout.write(`${value}\n`)

  return {
    banner() {
      line("")
      line(paint(36, "  SAFECAFE RELEASE"))
      line(paint(90, "  Cloudflare Pages + Filebase/IPFS + ENS verification"))
      line("")
    },
    section(title: string) {
      section += 1
      line("")
      line(`${paint(36, `◆ ${section}`)}  ${paint(1, title)}`)
    },
    success(message: string) {
      line(`  ${paint(32, "✓")} ${message}`)
    },
    warning(message: string) {
      line(`  ${paint(33, "!")} ${message}`)
    },
    failure(message: string) {
      line("")
      line(`  ${paint(31, "✕ 发布失败")}`)
      for (const part of message.split("\n")) line(`  ${part}`)
    },
    info(message: string) {
      line(`  ${paint(90, "→")} ${message}`)
    },
    keyValue(label: string, value: string) {
      line(`    ${paint(90, `${label}:`)} ${value}`)
    },
    manualAction(uri: string, managerUrl: string) {
      line("")
      line(paint(33, "  ┌────────────────────────────────────────────────────────────┐"))
      line(paint(33, "  │ 需要手动更新 ENS                                          │"))
      line(paint(33, "  └────────────────────────────────────────────────────────────┘"))
      line(`    ENS:         ${ensName}`)
      line(`    contenthash: ${paint(36, uri)}`)
      line(`    管理入口:    ${managerUrl}`)
      line("")
    },
    complete(path: string) {
      line("")
      line(paint(32, "  ✓ 发布与验证全部完成"))
      line(`    Cloudflare、IPFS 和 ${ensName} 已指向同一发布 CID。`)
      line(`    会话记录: ${path}`)
      line("    生成的 release records 仍需人工审查和提交。")
      line("")
    },
    versionPrepared(version: string) {
      line("")
      line(paint(32, `  ✓ 已准备发布版本 ${version}`))
      line("    已同步根 package、safe-lite package 与前端/CLI 版本常量。")
      line("    请审查并提交版本变更，然后再次运行 pnpm release。")
      line("    此阶段未执行构建、上传、部署或 ENS 操作。")
      line("")
    },
  }
}

async function runLoggedCommand(
  logger: ReleaseLogger,
  label: string,
  command: string,
  commandArgs: string[],
  secrets: string[],
): Promise<void> {
  const startedAt = Date.now()
  logger.info(label)
  await runCommand(command, commandArgs, { secrets })
  logger.success(`${label} (${formatDuration(Date.now() - startedAt)})`)
}

function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: [options.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    })
    let output = ""
    const stdoutRedactor = createReleaseOutputRedactor(options.secrets ?? [], (value) => process.stdout.write(value))
    const stderrRedactor = createReleaseOutputRedactor(options.secrets ?? [], (value) => process.stderr.write(value))
    const collect = (chunk: Buffer, redactor: ReturnType<typeof createReleaseOutputRedactor>) => {
      const text = chunk.toString()
      output += text
      if (!options.quiet) redactor.write(text)
    }
    const flush = () => {
      if (options.quiet) return
      stdoutRedactor.flush()
      stderrRedactor.flush()
    }
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdoutRedactor))
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderrRedactor))
    if (options.input !== undefined) child.stdin?.end(options.input)
    child.on("error", (error) => {
      flush()
      rejectCommand(error)
    })
    child.on("close", (code) => {
      flush()
      if (code === 0) resolveCommand(output)
      else
        rejectCommand(
          new Error(`${command} ${args.join(" ")} exited with code ${String(code)}.\n${output.slice(-4_000)}`),
        )
    })
  })
}

async function loadEnvironment(): Promise<NodeJS.ProcessEnv> {
  const values: NodeJS.ProcessEnv = { ...process.env }
  const envFileKeys = new Set<string>()
  try {
    const source = await readFile(resolve(".env"), "utf8")
    releaseEnvFileFound = true
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!match) continue
      const [, key, rawValue] = match
      if (key) {
        envFileKeys.add(key)
        values[key] = unquote(rawValue?.trim() ?? "")
      }
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }
  if (releaseEnvFileFound) {
    for (const key of Object.keys(values)) {
      if (isReleaseConfigEnvironmentName(key) && !envFileKeys.has(key)) delete values[key]
    }
  }
  return values
}

function applyEnvironment(environment: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (isReleaseConfigEnvironmentName(key) && !(key in environment)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") process.env[key] = value
  }
}

function isReleaseConfigEnvironmentName(name: string) {
  return name.startsWith("SAFECAFE_") || name.startsWith("VITE_") || name.startsWith("FILEBASE_")
}

function assertRequiredEnvironment(environment: NodeJS.ProcessEnv) {
  const missing = ["FILEBASE_ACCESS_TOKEN", "FILEBASE_SECRET_KEY"].filter((name) => !environment[name]?.trim())
  if (missing.length) throw new Error(`Missing required release environment variables: ${missing.join(", ")}.`)
}

function collectSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => value && /(TOKEN|SECRET|PASSWORD|API_KEY|API_KEYS)$/i.test(name))
    .map(([, value]) => value as string)
}

function createEnsClient(environment: NodeJS.ProcessEnv) {
  const configuredUrls = [
    ...(environment.SAFECAFE_RPC_URLS ?? "").split(","),
    environment.SAFECAFE_RPC_URL ?? "",
    environment.VITE_RPC_URL ?? "",
  ]
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value))
  const rpcUrls = [...new Set(configuredUrls.length ? configuredUrls : DEFAULT_RPC_URLS)]
  return createPublicClient({
    chain: mainnet,
    transport: fallback(rpcUrls.map((url) => http(url, { timeout: 20_000 }))),
  })
}

const fetchWithTimeout: typeof fetch = (input, init = {}) =>
  fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporaryPath, path)
}

async function writeTextAtomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, value, "utf8")
  await rename(temporaryPath, path)
}

async function readLatestReleaseVersion(): Promise<string | null> {
  for (const path of latestReleaseRecordPaths) {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as { version?: unknown }
      if (typeof record.version !== "string") throw new Error(`Release record ${path} does not contain a version.`)
      return record.version
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue
      throw error
    }
  }
  return null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false
    throw error
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

const isMain = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (isMain) void main()
