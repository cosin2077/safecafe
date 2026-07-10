import type { Address, Hex } from "viem"

export type SafeLitePlannedTx = {
  data: Hex
  label: string
  to: Address
  value: bigint
}

export type SafeLiteOperation = 0

export type SafeLiteTransaction = {
  baseGas: bigint
  data: Hex
  gasPrice: bigint
  gasToken: Address
  nonce: bigint
  operation: SafeLiteOperation
  refundReceiver: Address
  safeTxGas: bigint
  to: Address
  value: bigint
}

export type SafeLiteServiceTransactionData = {
  baseGas: string
  data: Hex
  gasPrice: string
  gasToken: Address
  nonce: string
  operation: SafeLiteOperation
  refundReceiver: Address
  safeTxGas: string
  to: Address
  value: string
}

export type SafeLiteConfirmation = {
  owner: Address
  signature: Hex
}

export type SafeLiteAccountInfo = {
  chainId: bigint
  isOwner: boolean
  nonce: bigint
  owners: Address[]
  threshold: number
}

export type SafeLiteTxService = {
  confirmTransaction(safeTxHash: Hex, signature: Hex): Promise<unknown>
  getTransactionConfirmations(safeTxHash: Hex): Promise<unknown>
  proposeTransaction(input: {
    origin?: string
    safeAddress: Address
    safeTransactionData: SafeLiteServiceTransactionData
    safeTxHash: Hex
    senderAddress: Address
    senderSignature: Hex
  }): Promise<void>
}

export type SafeLitePlanResult =
  | {
      mode: "executed"
      completedTxs: number
      hash: Hex
      safeTxHash: Hex
      threshold: number
    }
  | {
      completedTxs: number
      mode: "proposed"
      confirmations: number
      safeTxHash: Hex
      threshold: number
      txIndex: number
      txLabel: string
    }

export type SafeLiteSendTransaction = (
  transaction: { data: Hex; to: Address; value: bigint },
  tx: SafeLitePlannedTx,
) => Promise<Hex>

export type SafeLiteSignHash = (safeTxHash: Hex) => Promise<Hex>

export type SafeLiteWaitForReceipt = (
  hash: Hex,
  tx: SafeLitePlannedTx,
) => Promise<{ blockNumber?: bigint; status?: string } | null>
