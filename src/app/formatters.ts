import { parseSafeAmount, type TxPlan } from "../protocol"
import type { MessageBundle } from "./i18n"
import type { SafePriceState } from "./types"

export function safeParsedAmount(value: string): bigint | null {
  try {
    return parseSafeAmount(value)
  } catch {
    return null
  }
}

export function priceStatusLabel(price: SafePriceState, t: MessageBundle) {
  if (price.usd === null) return t.priceUnavailable
  const age = price.fetchedAt ? formatPriceAge(Date.now() - price.fetchedAt) : t.notChecked
  return `${price.source} · ${price.stale ? t.priceStale : t.priceCached} · ${age}`
}

export function translateTxLabel(label: string, t: MessageBundle) {
  const labels: Record<string, string> = {
    "Approve SAFE for staking contract": t.txApproveSafe,
    "Stake SAFE to validator": t.txStakeSafe,
    "Initiate withdrawal from validator": t.txInitiateWithdrawal,
    "Claim next FIFO withdrawal": t.txClaimWithdrawal,
    "Claim Merkle rewards": t.txClaimRewards,
  }
  return labels[label] ?? label
}

export function translateTxWarning(warning: string, t: MessageBundle) {
  const warnings: Record<string, string> = {
    "This plan needs approval before staking unless your wallet supports batching.": t.warningApprovalNeeded,
    "Withdrawals enter the protocol queue and become claimable after the delay.": t.warningWithdrawalQueue,
    "The staking contract claims withdrawals in FIFO order.": t.warningClaimFifo,
  }
  return warnings[warning] ?? warning
}

export function translateTxTitle(plan: TxPlan, t: MessageBundle) {
  if (plan.action === "stake") return `${t.txStakeTitle} ${plan.title.replace(/^Stake\s+/, "")}`
  if (plan.action === "unstake") return `${t.txUnstakeTitle} ${plan.title.replace(/^Unstake\s+/, "")}`
  if (plan.action === "claim-withdrawal") return t.txClaimWithdrawalTitle
  if (plan.action === "claim-rewards") return t.txClaimRewardsTitle
  return plan.title
}

export function formatPriceAge(ageMs: number) {
  const minutes = Math.max(0, Math.floor(ageMs / 60000))
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export function formatDelayLabel(seconds: bigint, t: MessageBundle) {
  const value = Number(seconds)
  const days = Math.floor(value / 86400)
  if (days > 0) return `${days} ${days === 1 ? t.day : t.days}`
  const hours = Math.floor(value / 3600)
  if (hours > 0) return `${hours} ${hours === 1 ? t.hour : t.hours}`
  const minutes = Math.floor(value / 60)
  return `${minutes} ${minutes === 1 ? t.minute : t.minutes}`
}

export function readableSimulationError(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage
    if (typeof shortMessage === "string" && shortMessage.trim()) return shortMessage
  }
  return error instanceof Error ? error.message : fallback
}

export function merkleLabel(t: MessageBundle, matched: boolean | null) {
  if (matched === null) return t.merkleNotChecked
  return matched ? t.merkleMatched : t.merkleMismatch
}

export function stringifyBigInts<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T
}

export function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
