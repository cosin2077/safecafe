import { type Address, getAddress, isAddress } from "viem"

import type { AccountSnapshot, ValidatorInfo } from "../protocol"
import { stringifyBigInts } from "./formatters"
import { appStorageKeys, readStorageJson, writeStorageJson } from "./persistence"

export const accountLiveCacheFreshMs = 60 * 1000

const accountLiveCacheMaxAgeMs = 15 * 60 * 1000
const accountLiveCacheMaxEntries = 8

export type RewardProof = {
  cumulativeAmount: string
  merkleRoot: `0x${string}`
  proof: `0x${string}`[] | null
}

export type RewardProofStatus = "available" | "missing" | "unavailable"

export type LiveReadResult = {
  health: {
    blockNumber: bigint
    merkleRoot: `0x${string}`
    withdrawDelay: bigint
  }
  rewardProof: RewardProof | null
  rewardProofStatus: RewardProofStatus
  rewards: bigint
  snapshot: AccountSnapshot
  validatorsWithPositions: ValidatorInfo[]
}

export type CachedLiveData = {
  data: LiveReadResult
  fetchedAt: number
}

type StoredLiveDataEntry = {
  account: Address
  fetchedAt: number
  payload: unknown
}

type StoredLiveDataCache = Record<string, StoredLiveDataEntry>

export function readCachedLiveData(account: Address, now = Date.now()): CachedLiveData | null {
  const key = account.toLowerCase()
  const entry = readStoredLiveDataCache()[key]
  const ageMs = entry ? now - entry.fetchedAt : Number.POSITIVE_INFINITY
  if (!entry || ageMs < 0 || ageMs > accountLiveCacheMaxAgeMs) return null
  try {
    return {
      data: parseLiveReadResult(entry.payload),
      fetchedAt: entry.fetchedAt,
    }
  } catch {
    return null
  }
}

export function writeCachedLiveData(account: Address, data: LiveReadResult, fetchedAt = Date.now()) {
  const cache = readStoredLiveDataCache()
  const normalizedAccount = getAddress(account) as Address
  const cutoff = fetchedAt - accountLiveCacheMaxAgeMs

  cache[normalizedAccount.toLowerCase()] = {
    account: normalizedAccount,
    fetchedAt,
    payload: stringifyBigInts(data),
  }

  const pruned = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => entry.fetchedAt >= cutoff)
      .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
      .slice(0, accountLiveCacheMaxEntries),
  )

  writeStorageJson(appStorageKeys.accountLiveCache, pruned)
  return fetchedAt
}

export function parseLiveReadResult(value: unknown): LiveReadResult {
  if (!value || typeof value !== "object") {
    throw new Error("Account live API returned an invalid payload.")
  }
  const data = value as {
    health?: { blockNumber?: string; merkleRoot?: string; withdrawDelay?: string }
    rewardProof?: unknown
    rewardProofStatus?: unknown
    rewards?: unknown
    snapshot?: {
      cumulativeClaimed?: string
      nextClaimableWithdrawal?: { amount?: string; claimableAt?: string }
      pendingWithdrawals?: Array<{ amount?: string; claimableAt?: string }>
      safeBalance?: string
      stakingAllowance?: string
      totalStaked?: string
      withdrawDelay?: string
    }
    validatorsWithPositions?: Array<ValidatorInfo & { totalStake?: string; userStake?: string }>
  }
  if (!data.health || !data.snapshot || !Array.isArray(data.validatorsWithPositions)) {
    throw new Error("Account live API returned an invalid payload.")
  }
  if (typeof data.health.merkleRoot !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data.health.merkleRoot)) {
    throw new Error("Account live API returned an invalid merkle root.")
  }
  return {
    health: {
      blockNumber: toBigInt(data.health.blockNumber),
      merkleRoot: data.health.merkleRoot as `0x${string}`,
      withdrawDelay: toBigInt(data.health.withdrawDelay),
    },
    rewardProof: parseRewardProof(data.rewardProof),
    rewardProofStatus: parseRewardProofStatus(data.rewardProofStatus, data.rewardProof),
    rewards: toBigInt(data.rewards),
    snapshot: {
      cumulativeClaimed: toBigInt(data.snapshot.cumulativeClaimed),
      nextClaimableWithdrawal: {
        amount: toBigInt(data.snapshot.nextClaimableWithdrawal?.amount),
        claimableAt: toBigInt(data.snapshot.nextClaimableWithdrawal?.claimableAt),
      },
      pendingWithdrawals: (data.snapshot.pendingWithdrawals ?? []).map((item) => ({
        amount: toBigInt(item.amount),
        claimableAt: toBigInt(item.claimableAt),
      })),
      safeBalance: toBigInt(data.snapshot.safeBalance),
      stakingAllowance: toBigInt(data.snapshot.stakingAllowance),
      totalStaked: toBigInt(data.snapshot.totalStaked),
      withdrawDelay: toBigInt(data.snapshot.withdrawDelay),
    },
    validatorsWithPositions: data.validatorsWithPositions.map((validator) => ({
      ...validator,
      totalStake: toBigInt(validator.totalStake),
      userStake: toBigInt(validator.userStake),
    })),
  }
}

function parseRewardProofStatus(value: unknown, proof: unknown): RewardProofStatus {
  if (value === "available" || value === "missing" || value === "unavailable") return value
  return parseRewardProof(proof) ? "available" : "missing"
}

export function toBigInt(value: unknown) {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

function parseRewardProof(value: unknown): RewardProof | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<RewardProof>
  if (typeof record.cumulativeAmount !== "string" || !/^\d+$/.test(record.cumulativeAmount)) return null
  if (typeof record.merkleRoot !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.merkleRoot)) return null
  const proof = Array.isArray(record.proof) ? record.proof : null
  if (
    proof &&
    !proof.every((entry): entry is `0x${string}` => typeof entry === "string" && /^0x[0-9a-fA-F]{64}$/.test(entry))
  ) {
    return null
  }
  return {
    cumulativeAmount: record.cumulativeAmount,
    merkleRoot: record.merkleRoot,
    proof,
  }
}

function readStoredLiveDataCache(): StoredLiveDataCache {
  return (
    readStorageJson(appStorageKeys.accountLiveCache, (value) => {
      if (!value || typeof value !== "object") return {}
      const cache: StoredLiveDataCache = {}
      for (const [key, item] of Object.entries(value)) {
        if (!item || typeof item !== "object") continue
        const account = normalizeAddress((item as { account?: unknown }).account)
        const fetchedAt = (item as { fetchedAt?: unknown }).fetchedAt
        const payload = (item as { payload?: unknown }).payload
        if (!account || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || !payload) continue
        const normalizedKey = account.toLowerCase()
        if (key.toLowerCase() !== normalizedKey) continue
        cache[normalizedKey] = { account, fetchedAt, payload }
      }
      return cache
    }) ?? {}
  )
}

function normalizeAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as Address) : null
}
