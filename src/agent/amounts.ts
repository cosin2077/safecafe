import { formatUnits, parseUnits } from "viem"
import type { AccountSummary } from "../app/types"
import type { ValidatorInfo } from "../protocol"
import type { AgentAmount } from "./types"

export type AgentAmountContext = { summary: AccountSummary }
export type ResolvedAgentAmount = { text: string; value: bigint }

export function resolveAgentAmount(
  amount: AgentAmount,
  context: AgentAmountContext,
  validator?: ValidatorInfo,
): ResolvedAgentAmount {
  if (amount.type === "safe") return { text: amount.value, value: parseSafeAmountText(amount.value) }
  if (amount.type === "all-wallet") return fromBigint(context.summary.safeBalance)
  if (amount.type === "all-claimable-rewards") return fromBigint(context.summary.claimableRewards)
  if (amount.type === "all-validator-stake") {
    if (!validator) throw new Error("Validator stake amount requires a validator.")
    return fromBigint(validator.userStake)
  }
  if (amount.type === "percent-wallet") return percent(context.summary.safeBalance, amount.value)
  if (amount.type === "percent-validator-stake") {
    if (!validator) throw new Error("Validator percentage requires a validator.")
    return percent(validator.userStake, amount.value)
  }
  throw new Error("Unsupported amount.")
}

function percent(base: bigint, value: number): ResolvedAgentAmount {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error("Percent must be greater than 0 and at most 100.")
  }
  return fromBigint((base * BigInt(Math.round(value * 100))) / 10000n)
}

function fromBigint(value: bigint): ResolvedAgentAmount {
  return { value, text: trimSafe(formatUnits(value, 18)) }
}

function trimSafe(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
}

function parseSafeAmountText(value: string): bigint {
  const clean = value.trim().replace(/,/g, "")
  if (!/^\d+(\.\d{1,18})?$/.test(clean)) {
    throw new Error("Amount must be a SAFE decimal with at most 18 decimals.")
  }
  const parsed = parseUnits(clean, 18)
  if (parsed <= 0n) throw new Error("Amount must be greater than zero.")
  return parsed
}
