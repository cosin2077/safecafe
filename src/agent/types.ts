import type { Address, Hex } from "viem"
import type { AccountSummary } from "../app/types"
import type { AccountSnapshot, TxPlan, ValidatorInfo } from "../protocol"

export type AgentAmount =
  | { type: "safe"; value: string }
  | { type: "percent-wallet"; value: number }
  | { type: "percent-validator-stake"; value: number }
  | { type: "all-wallet" }
  | { type: "all-validator-stake" }
  | { type: "all-claimable-rewards" }

export type AgentValidatorRef =
  | { type: "address"; value: Address }
  | { type: "label"; value: string }
  | { type: "best-active" }

export type AgentIntent =
  | { kind: "stake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "unstake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "claim-withdrawal" }
  | { kind: "claim-rewards" }
  | { kind: "restake-rewards"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "rebalance"; from: AgentValidatorRef; to: AgentValidatorRef; amount: AgentAmount }
  | { kind: "compound-liquid"; amount: AgentAmount; validator: AgentValidatorRef }

export type AgentRisk = {
  severity: "info" | "warning" | "blocked"
  code: string
  message: string
}

export type AgentPlanPhase = {
  id: string
  title: string
  executableNow: boolean
  plans: TxPlan[]
  risks: AgentRisk[]
}

export type AgentPlan = {
  id: string
  instruction: string
  intent: AgentIntent
  account: Address | null
  createdAtBlock: bigint | null
  phases: AgentPlanPhase[]
  risks: AgentRisk[]
}

export type AgentContext = {
  account: Address | null
  chainId: number | null
  liveBlock: bigint | null
  liveSnapshot: AccountSnapshot | null
  summary: AccountSummary
  validators: ValidatorInfo[]
  rewardProof: { cumulativeAmount: string; merkleRoot: Hex; proof: Hex[] | null } | null
  liveMerkleRoot: string | null
}

export type AgentParseResult =
  | { status: "ok"; intent: AgentIntent; risks: AgentRisk[] }
  | { status: "needs-clarification"; question: string; risks: AgentRisk[] }
  | { status: "blocked"; risks: AgentRisk[] }
