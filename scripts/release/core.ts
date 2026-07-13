import { type Hex, hexToBytes } from "viem"
import { cloudflarePagesRuntimeSecretNames } from "../../src/server/envNames"

export type ReleaseArgs = {
  bump: ReleaseVersionBump
  pollIntervalMs: number
  quick: boolean
  yes: boolean
}

export type ReleaseVersionBump = "major" | "minor" | "patch"

export type ReleaseVersionPlan =
  | { action: "prepare"; currentVersion: string; nextVersion: string }
  | { action: "release"; version: string }

export type ReleaseStage = "awaiting_ens" | "cloudflare_deployed" | "ipfs_published" | "verified"

export type ReleaseSession = {
  version: 1
  commit: string
  cid: string
  uri: string
  cloudflareDeploymentUrl: string | null
  stage: ReleaseStage
  createdAt: string
  updatedAt: string
}

export type ReleaseOutputRedactor = {
  flush: () => void
  write: (value: string) => void
}

export function collectCloudflarePagesSecrets(environment: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  return cloudflarePagesRuntimeSecretNames
    .map((name) => ({ name, value: environment[name]?.trim() ?? "" }))
    .filter((entry) => entry.value.length > 0)
}

export function extractCloudflarePagesSecretNames(output: string) {
  const knownNames = new Set<string>(cloudflarePagesRuntimeSecretNames)
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+([A-Z0-9_]+):/)?.[1] ?? "")
    .filter((name) => knownNames.has(name))
}

export function planCloudflarePagesSecretSync(
  environment: NodeJS.ProcessEnv,
  existingSecretNames: readonly string[],
  strict: boolean,
) {
  const put = collectCloudflarePagesSecrets(environment)
  if (!strict) return { delete: [] as string[], put }
  const desiredNames = new Set(put.map((entry) => entry.name))
  const knownNames = new Set<string>(cloudflarePagesRuntimeSecretNames)
  const deleteNames = existingSecretNames.filter((name) => knownNames.has(name) && !desiredNames.has(name)).sort()
  return { delete: deleteNames, put }
}

export function parseReleaseArgs(argv: string[]): ReleaseArgs {
  const result: ReleaseArgs = {
    bump: "patch",
    pollIntervalMs: 15_000,
    quick: false,
    yes: false,
  }

  for (const argument of argv) {
    if (argument === "--quick") result.quick = true
    else if (argument === "--yes") result.yes = true
    else if (argument.startsWith("--bump=")) {
      const bump = argument.slice("--bump=".length)
      if (bump !== "major" && bump !== "minor" && bump !== "patch") {
        throw new Error("Version bump must be major, minor, or patch.")
      }
      result.bump = bump
    } else if (argument.startsWith("--poll-interval=")) {
      const secondsText = argument.slice("--poll-interval=".length)
      if (!/^\d+$/.test(secondsText)) throw new Error("Poll interval must be a whole number of seconds.")
      const seconds = Number(secondsText)
      if (seconds < 5) throw new Error("Poll interval must be at least 5 seconds.")
      if (seconds > 3_600) throw new Error("Poll interval cannot exceed 3600 seconds.")
      result.pollIntervalMs = seconds * 1_000
    } else {
      throw new Error(`Unknown release option: ${argument}`)
    }
  }

  return result
}

export function planReleaseVersion(
  currentVersion: string,
  latestVersion: string | null,
  bump: ReleaseVersionBump,
): ReleaseVersionPlan {
  const current = parseSemanticVersion(currentVersion)
  if (!latestVersion) return { action: "release", version: currentVersion }
  const latest = parseSemanticVersion(latestVersion)
  const comparison = compareSemanticVersion(current, latest)
  if (comparison < 0) {
    throw new Error(`Current version ${currentVersion} is behind latest release ${latestVersion}.`)
  }
  if (comparison > 0) return { action: "release", version: currentVersion }

  const next = { ...current }
  if (bump === "major") {
    next.major += 1
    next.minor = 0
    next.patch = 0
  } else if (bump === "minor") {
    next.minor += 1
    next.patch = 0
  } else {
    next.patch += 1
  }
  return {
    action: "prepare",
    currentVersion,
    nextVersion: `${next.major}.${next.minor}.${next.patch}`,
  }
}

export function renderSafecafeVersionModule(version: string): string {
  parseSemanticVersion(version)
  return `export const SAFECAFE_VERSION = "${version}"\n`
}

export function decodeIpfsContenthash(value: string): string | null {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) return null
  const bytes = hexToBytes(value as Hex)
  const prefix = decodeVarint(bytes)
  if (prefix?.value !== 0xe3) return null
  const payload = bytes.slice(prefix.bytesRead)
  if (!payload.length) return null
  return encodeBase32Multibase(payload)
}

export function redactReleaseError(value: unknown, secrets: string[] = []): string {
  let output = value instanceof Error ? value.message : String(value)
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]")
  }
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|secret|token|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
}

export function createReleaseOutputRedactor(secrets: string[], emit: (value: string) => void): ReleaseOutputRedactor {
  let pending = ""

  return {
    write(value) {
      pending += value
      let newlineIndex = pending.indexOf("\n")
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex + 1)
        pending = pending.slice(newlineIndex + 1)
        emit(redactReleaseError(line, secrets))
        newlineIndex = pending.indexOf("\n")
      }
    },
    flush() {
      if (pending) emit(redactReleaseError(pending, secrets))
      pending = ""
    },
  }
}

function decodeVarint(bytes: Uint8Array): { bytesRead: number; value: number } | null {
  let value = 0
  let shift = 0
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { bytesRead: index + 1, value }
    shift += 7
    if (shift > 28) return null
  }
  return null
}

function encodeBase32Multibase(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  let buffer = 0
  let bits = 0
  let output = "b"

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 0x1f] ?? ""
      bits -= 5
      buffer &= (1 << bits) - 1
    }
  }

  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 0x1f] ?? ""
  return output
}

type SemanticVersion = {
  major: number
  minor: number
  patch: number
}

function parseSemanticVersion(value: string): SemanticVersion {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!match) throw new Error(`Version ${value} is not a valid semantic version.`)
  const [, majorText, minorText, patchText] = match
  const version = {
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
  }
  if (!Object.values(version).every(Number.isSafeInteger)) {
    throw new Error(`Version ${value} is not a valid semantic version.`)
  }
  return version
}

function compareSemanticVersion(first: SemanticVersion, second: SemanticVersion): number {
  return first.major - second.major || first.minor - second.minor || first.patch - second.patch
}
