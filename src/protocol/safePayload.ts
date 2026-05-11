import type { Address } from "viem"
import type { TxPlan } from "./txPlan"

export type SafeTransactionPayload = {
  version: "1.0"
  chainId: string
  createdAt: string
  meta: {
    name: string
    description: string
  }
  transactions: {
    to: Address
    value: string
    data: string
    contractMethod: null
    contractInputsValues: null
  }[]
}

export type SafeTransactionPayloadOptions = {
  description?: string
}

export function toSafeTransactionPayload(
  plan: TxPlan,
  chainId = 1,
  options: SafeTransactionPayloadOptions = {},
): SafeTransactionPayload {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: new Date().toISOString(),
    meta: {
      name: plan.title,
      description: options.description ?? "Generated for Safenet staking. Review all transactions before signing.",
    },
    transactions: plan.txs.map((tx) => ({
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  }
}
