import {
  DirectSafeTxServiceClient,
  normalizeSafeLitePersonalSignature,
  ProxiedSafeTxServiceClient,
  type SafeTxErrorMessages,
  safeTxServiceUrl,
  submitSafeLitePlan,
  valueToRpcHex,
} from "@safecafe/safe-lite"
import type { Address, Hex } from "viem"
import { createSafenetPublicClient, type TxPlan } from "../protocol"

type Eip1193Provider = {
  request: (args: { method: string; params?: object | readonly unknown[] }) => Promise<unknown>
}

type SafeProtocolKitLike = {
  createTransaction(input: { transactions: Array<{ data: string; to: string; value: string }> }): Promise<unknown>
  executeTransaction(transaction: unknown): Promise<{ hash: string }>
  getChainId(): Promise<bigint>
  getThreshold(): Promise<number>
  getTransactionHash(transaction: unknown): Promise<string>
  isOwner(owner: string): Promise<boolean>
  signHash(safeTxHash: string): Promise<{ data: string }>
}

type SafeApiKitLike = {
  confirmTransaction(safeTxHash: string, signature: string): Promise<unknown>
  getTransaction(safeTxHash: string): Promise<unknown>
  getTransactionConfirmations(safeTxHash: string): Promise<unknown>
  proposeTransaction(input: {
    origin?: string
    safeAddress: string
    safeTransactionData: unknown
    safeTxHash: string
    senderAddress: string
    senderSignature: string
  }): Promise<void>
}

type SafeMultisigTestKit = {
  createSafeApiKit?: (config: { chainId: bigint; txServiceUrl?: string; userSafeApiKey?: string }) => SafeApiKitLike
  createSafeProtocolKit?: (config: {
    provider: Eip1193Provider
    safeAddress: string
    signer: string
  }) => Promise<SafeProtocolKitLike>
}

export type SafeMultisigProposalResult =
  | { mode: "executed"; hash: Hex; safeTxHash: string; threshold: number }
  | {
      completedTxs: number
      mode: "proposed"
      confirmations: number
      safeTxHash: string
      threshold: number
      txIndex: number
      txLabel: string
    }

export async function submitSafeMultisigPlan(params: {
  origin: string
  plan: TxPlan
  provider: Eip1193Provider
  safeAddress: Address
  safeTxErrorMessages?: SafeTxErrorMessages
  signer: Address
  authToken?: string | null
  rpcUrl?: string
  userSafeApiKey?: string
}): Promise<SafeMultisigProposalResult> {
  const testKit = readTestKit()
  if (testKit?.createSafeProtocolKit) return submitWithTestKit(params, testKit)

  const publicClient = createSafenetPublicClient({ authToken: params.authToken, rpcUrl: params.rpcUrl })
  const txService = params.userSafeApiKey?.trim()
    ? new DirectSafeTxServiceClient({
        apiKey: params.userSafeApiKey.trim(),
        baseUrl: safeTxServiceUrl(1n),
        messages: params.safeTxErrorMessages,
      })
    : new ProxiedSafeTxServiceClient({
        authToken: params.authToken,
        messages: params.safeTxErrorMessages,
        safeAddress: params.safeAddress,
        senderAddress: params.signer,
      })

  const result = await submitSafeLitePlan({
    client: publicClient,
    origin: params.origin,
    safeAddress: params.safeAddress,
    signerAddress: params.signer,
    txService,
    txs: params.plan.txs,
    signHash: async (safeTxHash) => {
      const signature = await params.provider.request({
        method: "personal_sign",
        params: [safeTxHash, params.signer],
      })
      if (typeof signature !== "string") throw new Error("Wallet did not return a Safe signature.")
      return normalizeSafeLitePersonalSignature(signature as Hex)
    },
    sendTransaction: async (transaction) => {
      const hash = await params.provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            data: transaction.data,
            from: params.signer,
            to: transaction.to,
            value: valueToRpcHex(transaction.value),
          },
        ],
      })
      if (typeof hash !== "string") throw new Error("Wallet did not return a transaction hash.")
      return hash as Hex
    },
    waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
  })

  if (result.mode === "proposed") {
    return {
      mode: "proposed",
      completedTxs: result.completedTxs,
      confirmations: result.confirmations,
      safeTxHash: result.safeTxHash,
      threshold: result.threshold,
      txIndex: result.txIndex,
      txLabel: result.txLabel,
    }
  }
  return {
    mode: "executed",
    hash: result.hash,
    safeTxHash: result.safeTxHash,
    threshold: result.threshold,
  }
}

async function submitWithTestKit(
  params: {
    origin: string
    plan: TxPlan
    provider: Eip1193Provider
    safeAddress: Address
    safeTxErrorMessages?: SafeTxErrorMessages
    signer: Address
    authToken?: string | null
    userSafeApiKey?: string
  },
  testKit: SafeMultisigTestKit,
): Promise<SafeMultisigProposalResult> {
  if (!testKit.createSafeProtocolKit) throw new Error("Safe multisig test kit is missing protocol support.")
  const protocolKit = await testKit.createSafeProtocolKit({
    provider: params.provider,
    safeAddress: params.safeAddress,
    signer: params.signer,
  })

  if (!(await protocolKit.isOwner(params.signer))) throw new Error("Connected wallet is not a Safe owner.")

  const transactions = params.plan.txs.map((tx) => ({
    data: tx.data,
    to: tx.to,
    value: tx.value.toString(),
  }))
  const safeTransaction = await protocolKit.createTransaction({ transactions })
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  const signature = await protocolKit.signHash(safeTxHash)
  const threshold = await protocolKit.getThreshold()
  const apiKit = testKit.createSafeApiKit?.({
    chainId: await protocolKit.getChainId(),
    txServiceUrl: safeTxServiceUrl(1n),
    userSafeApiKey: params.userSafeApiKey,
  })
  if (!apiKit) throw new Error("Safe multisig test kit is missing transaction service support.")

  const existingConfirmations = await readSafeConfirmations(apiKit, safeTxHash)
  let minimumConfirmations = 0
  let transactionReadyForExecution: unknown = null

  if (existingConfirmations.length === 0) {
    await apiKit.proposeTransaction({
      origin: params.origin,
      safeAddress: params.safeAddress,
      safeTransactionData: getSafeTransactionData(safeTransaction),
      safeTxHash,
      senderAddress: params.signer,
      senderSignature: signature.data,
    })
    minimumConfirmations = 1
    transactionReadyForExecution = safeTransaction
  } else if (!hasOwnerConfirmation(existingConfirmations, params.signer)) {
    minimumConfirmations = existingConfirmations.length
    await apiKit.confirmTransaction(safeTxHash, signature.data)
    minimumConfirmations += 1
  } else {
    minimumConfirmations = existingConfirmations.length
  }

  const confirmations = await countSafeConfirmations(apiKit, safeTxHash, minimumConfirmations)
  if (confirmations < threshold) {
    return {
      mode: "proposed",
      completedTxs: 0,
      confirmations,
      safeTxHash,
      threshold,
      txIndex: 0,
      txLabel: params.plan.txs[0]?.label ?? params.plan.title,
    }
  }

  const transaction = transactionReadyForExecution ?? (await apiKit.getTransaction(safeTxHash))
  const result = await protocolKit.executeTransaction(transaction)
  return { mode: "executed", hash: result.hash as Hex, safeTxHash, threshold }
}

async function readSafeConfirmations(apiKit: SafeApiKitLike, safeTxHash: string) {
  try {
    return readConfirmations(await apiKit.getTransactionConfirmations(safeTxHash))
  } catch {
    return []
  }
}

function hasOwnerConfirmation(confirmations: Array<{ owner: string }>, owner: Address) {
  return confirmations.some((confirmation) => confirmation.owner.toLowerCase() === owner.toLowerCase())
}

async function countSafeConfirmations(apiKit: SafeApiKitLike, safeTxHash: string, fallback = 0) {
  try {
    return Math.max(fallback, readConfirmations(await apiKit.getTransactionConfirmations(safeTxHash)).length)
  } catch {
    return fallback
  }
}

function readConfirmations(value: unknown): Array<{ owner: string }> {
  if (!value || typeof value !== "object") return []
  const results = (value as { results?: unknown }).results
  const confirmations = Array.isArray(results) ? results : Array.isArray(value) ? value : []
  return confirmations.filter(isOwnerConfirmation)
}

function isOwnerConfirmation(value: unknown): value is { owner: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { owner?: unknown }).owner === "string")
}

function getSafeTransactionData(transaction: unknown) {
  if (transaction && typeof transaction === "object" && "data" in transaction) {
    return (transaction as { data: unknown }).data
  }
  return transaction
}

function readTestKit(): SafeMultisigTestKit | null {
  return (window.__safecafeSafeMultisigTestKit as SafeMultisigTestKit | undefined) ?? null
}
