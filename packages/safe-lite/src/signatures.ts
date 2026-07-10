import { type Address, getAddress, type Hex, isHex, padHex } from "viem"
import type { SafeLiteConfirmation } from "./types.js"

export function buildApprovedHashSignature(owner: Address): Hex {
  const ownerWord = padHex(owner, { dir: "left", size: 32 })
  return `${ownerWord}${"0".repeat(64)}01` as Hex
}

export function normalizePersonalSafeSignature(signature: Hex): Hex {
  assertFixedSignature(signature)
  const prefix = signature.slice(0, -2)
  const rawV = Number.parseInt(signature.slice(-2), 16)
  const v = rawV === 0 || rawV === 1 ? rawV + 31 : rawV === 27 || rawV === 28 ? rawV + 4 : rawV
  if (v !== 31 && v !== 32) throw new Error(`Unsupported Safe EOA signature v value: ${rawV}.`)
  return `${prefix}${v.toString(16).padStart(2, "0")}` as Hex
}

export function packSafeSignatures(confirmations: readonly SafeLiteConfirmation[], threshold: number): Hex {
  const byOwner = new Map<string, SafeLiteConfirmation>()
  for (const confirmation of confirmations) {
    assertFixedSignature(confirmation.signature)
    const owner = getAddress(confirmation.owner)
    byOwner.set(owner.toLowerCase(), { owner, signature: confirmation.signature })
  }
  const ordered = [...byOwner.values()].sort((a, b) =>
    BigInt(a.owner.toLowerCase()) < BigInt(b.owner.toLowerCase()) ? -1 : 1,
  )
  if (ordered.length < threshold) {
    throw new Error(`Safe transaction needs ${threshold} confirmations; only ${ordered.length} are available.`)
  }
  return `0x${ordered
    .slice(0, threshold)
    .map((confirmation) => confirmation.signature.slice(2))
    .join("")}` as Hex
}

function assertFixedSignature(signature: Hex) {
  if (!isHex(signature) || signature.length !== 132) {
    throw new Error("Only fixed 65-byte Safe owner signatures are supported.")
  }
}
