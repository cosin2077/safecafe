import { decodeFunctionData } from "viem"
import { erc20Abi, merkleDropAbi, stakingAbi, type TxPlan } from "../protocol"

export type PlanExecutionStepStatus = "cancelled" | "done" | "failed" | "pending" | "skipped"

export type PlanExecutionStep = {
  id: string
  label: string
  status: PlanExecutionStepStatus
}

export type PlanExecutionSummary = {
  actionKey: string
  completedCount: number
  currentLabel: string | null
  errorMessage: string
  pendingCount: number
  skippedCount: number
  status: "completed" | "failed" | "partial"
  steps: PlanExecutionStep[]
  title: string
  userRejected: boolean
}

export function reconcileTxPlanForExecution(
  plan: TxPlan,
  input: {
    cumulativeClaimed: bigint
    stakingAllowance: bigint
  },
): {
  plan: TxPlan | null
  steps: PlanExecutionStep[]
} {
  const steps: PlanExecutionStep[] = plan.txs.map((tx, index) => ({
    id: `${index}:${tx.label}`,
    label: tx.label,
    status: "pending",
  }))
  const txs = plan.txs.filter((tx, index) => {
    if (canSkipClaimRewards(tx, input.cumulativeClaimed)) {
      steps[index] = { ...steps[index], status: "skipped" }
      return false
    }
    if (canSkipApproval(tx, input.stakingAllowance)) {
      steps[index] = { ...steps[index], status: "skipped" }
      return false
    }
    return true
  })
  return {
    plan: txs.length
      ? {
          ...plan,
          simulation: undefined,
          txs,
        }
      : null,
    steps,
  }
}

export function isUserRejectedRequest(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const maybeCode = "code" in error ? (error as { code?: unknown }).code : null
    if (maybeCode === 4001 || maybeCode === "ACTION_REJECTED") return true
    const maybeShortMessage = "shortMessage" in error ? (error as { shortMessage?: unknown }).shortMessage : null
    if (typeof maybeShortMessage === "string" && rejectedText(maybeShortMessage)) return true
  }
  return error instanceof Error ? rejectedText(error.message) : false
}

function canSkipApproval(tx: TxPlan["txs"][number], stakingAllowance: bigint) {
  if (tx.label !== "Approve SAFE for staking contract") return false
  try {
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: tx.data,
    })
    if (decoded.functionName !== "approve") return false
    const amount = decoded.args?.[1]
    return typeof amount === "bigint" && stakingAllowance >= amount
  } catch {
    return false
  }
}

function canSkipClaimRewards(tx: TxPlan["txs"][number], cumulativeClaimed: bigint) {
  if (tx.label !== "Claim Merkle rewards") return false
  try {
    const decoded = decodeFunctionData({
      abi: merkleDropAbi,
      data: tx.data,
    })
    if (decoded.functionName !== "claim") return false
    const cumulativeAmount = decoded.args?.[1]
    return typeof cumulativeAmount === "bigint" && cumulativeClaimed >= cumulativeAmount
  } catch {
    return false
  }
}

export function isStakeTx(tx: TxPlan["txs"][number]) {
  if (tx.label !== "Stake SAFE to validator") return false
  try {
    const decoded = decodeFunctionData({
      abi: stakingAbi,
      data: tx.data,
    })
    return decoded.functionName === "stake"
  } catch {
    return false
  }
}

function rejectedText(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.includes("user rejected") ||
    normalized.includes("user denied") ||
    normalized.includes("request rejected") ||
    normalized.includes("transaction rejected") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("rejected by user")
  )
}
