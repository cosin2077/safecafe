import assert from "node:assert/strict"

import {
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  parseAgentInstruction,
  resolveAgentAmount,
  resolveAgentValidator,
} from "../src/agent/index.ts"
import { isTxPlanForAccount } from "../src/protocol/index.ts"
import { mockAccount, mockSummary, mockValidators } from "../src/protocol/mockData.ts"
import { sanitizeAgentContent } from "../src/server/agentApi.ts"

function ok(input) {
  const result = parseAgentInstruction(input, mockValidators)
  assert.equal(result.status, "ok", input)
  return result.intent
}

assert.deepEqual(ok("stake 100 safe to Core Contributors"), {
  kind: "stake",
  amount: { type: "safe", value: "100" },
  validator: { type: "label", value: "Core Contributors" },
})
assert.deepEqual(ok("unstake 25% from Gnosis"), {
  kind: "unstake",
  amount: { type: "percent-validator-stake", value: 25 },
  validator: { type: "label", value: "Gnosis" },
})
assert.deepEqual(ok("claim rewards"), { kind: "claim-rewards" })
assert.deepEqual(ok("领取奖励"), { kind: "claim-rewards" })
assert.deepEqual(ok("claim withdrawal"), { kind: "claim-withdrawal" })
assert.deepEqual(ok("claim rewards and restake all to best validator"), {
  kind: "restake-rewards",
  amount: { type: "all-claimable-rewards" },
  validator: { type: "best-active" },
})
assert.deepEqual(ok("move 500 safe from Gnosis to Core Contributors"), {
  kind: "rebalance",
  from: { type: "label", value: "Gnosis" },
  to: { type: "label", value: "Core Contributors" },
  amount: { type: "safe", value: "500" },
})
assert.deepEqual(ok("质押 100 safe 到 Core Contributors"), {
  kind: "stake",
  amount: { type: "safe", value: "100" },
  validator: { type: "label", value: "Core Contributors" },
})

const unsupported = parseAgentInstruction("bridge SAFE to arbitrum", mockValidators)
assert.equal(unsupported.status, "blocked")
assert.equal(unsupported.risks[0].code, "unsupported-operation")
assert.equal(parseAgentInstruction("automatically stake 100 SAFE every day", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors every month", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors monthly", mockValidators).status, "blocked")
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors tomorrow", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("stake 100 SAFE to Core Contributors in 10 minutes", mockValidators).status,
  "blocked",
)
assert.equal(
  parseAgentInstruction("stake 100 SAFE to Core Contributors every Friday", mockValidators).status,
  "blocked",
)
assert.equal(parseAgentInstruction("stake 100 SAFE to Core Contributors at 9pm", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("submit for me and stake 100 SAFE to Core Contributors", mockValidators).status,
  "blocked",
)
assert.equal(parseAgentInstruction("每天自动复投奖励", mockValidators).status, "blocked")
assert.equal(
  parseAgentInstruction("please sign for me and stake 100 SAFE to Core Contributors", mockValidators).status,
  "blocked",
)

const empty = parseAgentInstruction("   ", mockValidators)
assert.equal(empty.status, "needs-clarification")

const eth = 10n ** 18n
const amountContext = {
  summary: {
    safeBalance: 1000n * eth,
    totalStaked: 2000n * eth,
    pendingWithdrawals: 0n,
    claimableWithdrawals: 0n,
    claimableRewards: 50n * eth,
    withdrawDelay: 0n,
  },
}
const core = mockValidators[0]
assert.equal(resolveAgentAmount({ type: "percent-wallet", value: 25 }, amountContext, core).text, "250")
assert.equal(resolveAgentAmount({ type: "percent-validator-stake", value: 50 }, amountContext, core).text, "1000")
assert.equal(resolveAgentAmount({ type: "all-claimable-rewards" }, amountContext, core).text, "50")
assert.equal(resolveAgentValidator({ type: "best-active" }, mockValidators).validator.label, "Core Contributors")

const agentContext = {
  account: mockAccount,
  chainId: 1,
  liveBlock: 123n,
  liveSnapshot: {
    safeBalance: mockSummary.safeBalance,
    totalStaked: mockSummary.totalStaked,
    pendingWithdrawals: [],
    nextClaimableWithdrawal: [mockSummary.claimableWithdrawals, 0n],
    cumulativeClaimed: 0n,
    withdrawDelay: mockSummary.withdrawDelay,
    stakingAllowance: 0n,
  },
  summary: mockSummary,
  validators: mockValidators,
  rewardProof: {
    cumulativeAmount: String(mockSummary.claimableRewards),
    merkleRoot: `0x${"11".repeat(32)}`,
    proof: [`0x${"22".repeat(32)}`],
  },
  liveMerkleRoot: `0x${"11".repeat(32)}`,
}

const stakePlan = compileAgentPlan(
  "stake 100 safe to Core Contributors",
  ok("stake 100 safe to Core Contributors"),
  agentContext,
)
assert.equal(
  stakePlan.risks.some((risk) => risk.severity === "blocked"),
  false,
)
assert.equal(flattenExecutableTxPlan(stakePlan)?.txs.length, 2)
assert.equal(flattenExecutableTxPlan(stakePlan)?.action, "agent-plan")
assert.equal(isTxPlanForAccount(flattenExecutableTxPlan(stakePlan), mockAccount), true)
assert.equal(isTxPlanForAccount(flattenExecutableTxPlan(stakePlan), `0x${"12".repeat(20)}`), false)

const claimPlan = compileAgentPlan("claim rewards", ok("claim rewards"), agentContext)
assert.equal(flattenExecutableTxPlan(claimPlan)?.action, "agent-plan")

const restakePlan = compileAgentPlan(
  "claim rewards and restake all to best validator",
  ok("claim rewards and restake all to best validator"),
  agentContext,
)
assert.equal(restakePlan.phases.length, 2)
assert.equal(restakePlan.phases[1].executableNow, false)
assert.equal(flattenExecutableTxPlan(restakePlan), null)
assert.equal(flattenCurrentExecutableTxPlan(restakePlan)?.action, "agent-plan")

const rebalancePlan = compileAgentPlan(
  "move 500 safe from Gnosis to Core Contributors",
  ok("move 500 safe from Gnosis to Core Contributors"),
  agentContext,
)
assert.equal(rebalancePlan.phases.length, 2)
assert.equal(rebalancePlan.phases[1].executableNow, false)
assert.equal(flattenExecutableTxPlan(rebalancePlan), null)
assert.equal(flattenCurrentExecutableTxPlan(rebalancePlan)?.action, "agent-plan")

const disconnectedPlan = compileAgentPlan(
  "claim rewards",
  { kind: "claim-rewards" },
  { ...agentContext, account: null },
)
assert.equal(disconnectedPlan.risks[0].code, "wallet-required")

const safeLlmFallback =
  "I can only help draft a reviewable staking plan. Every on-chain action must be confirmed in your wallet."
assert.equal(sanitizeAgentContent("I'll submit the transaction for you."), safeLlmFallback)
assert.equal(sanitizeAgentContent("call data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data"), safeLlmFallback)
assert.equal(sanitizeAgentContent("transaction data: 0xabcdefabcdefabcdefabcdefabcdefabcdef"), safeLlmFallback)
assert.equal(sanitizeAgentContent("我可以替你提交交易。"), safeLlmFallback)
assert.equal(sanitizeAgentContent("请帮我代提交交易。"), safeLlmFallback)
assert.equal(
  sanitizeAgentContent("You can review the staking plan before signing."),
  "You can review the staking plan before signing.",
)

console.log("Agent core tests passed")
