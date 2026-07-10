import { type Address, encodeFunctionData, getAddress, type Hex, isAddressEqual, type PublicClient, toHex } from "viem"
import { safeAccountAbi } from "./abi.js"
import { buildApprovedHashSignature, normalizePersonalSafeSignature, packSafeSignatures } from "./signatures.js"
import type {
  SafeLiteAccountInfo,
  SafeLiteConfirmation,
  SafeLitePlannedTx,
  SafeLitePlanResult,
  SafeLiteSendTransaction,
  SafeLiteServiceTransactionData,
  SafeLiteSignHash,
  SafeLiteTransaction,
  SafeLiteTxService,
  SafeLiteWaitForReceipt,
} from "./types.js"

const zeroAddress = "0x0000000000000000000000000000000000000000" as const

export async function readSafeLiteAccount(params: {
  client: PublicClient
  safeAddress: Address
  signerAddress: Address
}): Promise<SafeLiteAccountInfo> {
  const [chainId, owners, threshold, nonce] = await Promise.all([
    params.client.getChainId(),
    params.client.readContract({
      address: params.safeAddress,
      abi: safeAccountAbi,
      functionName: "getOwners",
    }),
    params.client.readContract({
      address: params.safeAddress,
      abi: safeAccountAbi,
      functionName: "getThreshold",
    }),
    params.client.readContract({
      address: params.safeAddress,
      abi: safeAccountAbi,
      functionName: "nonce",
    }),
  ])
  const normalizedOwners = owners.map((owner) => getAddress(owner))
  return {
    chainId: BigInt(chainId),
    isOwner: normalizedOwners.some((owner) => isAddressEqual(owner, params.signerAddress)),
    nonce,
    owners: normalizedOwners,
    threshold: Number(threshold),
  }
}

export function createSafeLiteTransaction(tx: SafeLitePlannedTx, nonce: bigint): SafeLiteTransaction {
  return {
    baseGas: 0n,
    data: tx.data,
    gasPrice: 0n,
    gasToken: zeroAddress,
    nonce,
    operation: 0,
    refundReceiver: zeroAddress,
    safeTxGas: 0n,
    to: tx.to,
    value: tx.value,
  }
}

export function toSafeLiteServiceTransactionData(tx: SafeLiteTransaction): SafeLiteServiceTransactionData {
  return {
    baseGas: tx.baseGas.toString(),
    data: tx.data,
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    nonce: tx.nonce.toString(),
    operation: tx.operation,
    refundReceiver: tx.refundReceiver,
    safeTxGas: tx.safeTxGas.toString(),
    to: tx.to,
    value: tx.value.toString(),
  }
}

export async function getSafeLiteTransactionHash(params: {
  client: PublicClient
  safeAddress: Address
  transaction: SafeLiteTransaction
}): Promise<Hex> {
  return params.client.readContract({
    address: params.safeAddress,
    abi: safeAccountAbi,
    functionName: "getTransactionHash",
    args: toSafeContractArgs(params.transaction),
  })
}

export function buildSafeLiteExecTransaction(params: {
  safeAddress: Address
  signatures: Hex
  transaction: SafeLiteTransaction
}): { data: Hex; to: Address; value: bigint } {
  return {
    to: params.safeAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: safeAccountAbi,
      functionName: "execTransaction",
      args: [
        params.transaction.to,
        params.transaction.value,
        params.transaction.data,
        params.transaction.operation,
        params.transaction.safeTxGas,
        params.transaction.baseGas,
        params.transaction.gasPrice,
        params.transaction.gasToken,
        params.transaction.refundReceiver,
        params.signatures,
      ],
    }),
  }
}

export function buildSafeLiteDirectExecTransaction(params: {
  nonce: bigint
  safeAddress: Address
  signerAddress: Address
  tx: SafeLitePlannedTx
}): { data: Hex; to: Address; value: bigint } {
  return buildSafeLiteExecTransaction({
    safeAddress: params.safeAddress,
    signatures: buildApprovedHashSignature(params.signerAddress),
    transaction: createSafeLiteTransaction(params.tx, params.nonce),
  })
}

export async function submitSafeLitePlan(params: {
  client: PublicClient
  origin?: string
  safeAddress: Address
  sendTransaction: SafeLiteSendTransaction
  signerAddress: Address
  signHash: SafeLiteSignHash
  txService: SafeLiteTxService
  txs: readonly SafeLitePlannedTx[]
  waitForReceipt?: SafeLiteWaitForReceipt
}): Promise<SafeLitePlanResult> {
  let lastHash: Hex | null = null
  let lastSafeTxHash: Hex | null = null
  let lastThreshold = 0
  let completedTxs = 0

  for (const [txIndex, tx] of params.txs.entries()) {
    const account = await readSafeLiteAccount({
      client: params.client,
      safeAddress: params.safeAddress,
      signerAddress: params.signerAddress,
    })
    if (!account.isOwner)
      throw new Error(`Signer ${params.signerAddress} is not an owner of Safe ${params.safeAddress}.`)
    const safeTransaction = createSafeLiteTransaction(tx, account.nonce)
    const safeTxHash = await getSafeLiteTransactionHash({
      client: params.client,
      safeAddress: params.safeAddress,
      transaction: safeTransaction,
    })
    lastSafeTxHash = safeTxHash
    lastThreshold = account.threshold
    if (account.threshold <= 1) {
      const hash = await params.sendTransaction(
        buildSafeLiteDirectExecTransaction({
          nonce: account.nonce,
          safeAddress: params.safeAddress,
          signerAddress: params.signerAddress,
          tx,
        }),
        tx,
      )
      lastHash = hash
      if (params.waitForReceipt) {
        const receipt = await params.waitForReceipt(hash, tx)
        if (receipt?.status !== "success") throw new Error(`Transaction failed: ${tx.label}`)
      }
      completedTxs += 1
      continue
    }
    const existingConfirmations = await readSafeLiteConfirmations(params.txService, safeTxHash)
    let confirmations = existingConfirmations
    if (confirmations.length === 0) {
      const ownerSignature = await params.signHash(safeTxHash)
      await params.txService.proposeTransaction({
        origin: params.origin,
        safeAddress: params.safeAddress,
        safeTransactionData: toSafeLiteServiceTransactionData(safeTransaction),
        safeTxHash,
        senderAddress: params.signerAddress,
        senderSignature: ownerSignature,
      })
      confirmations = [createLocalConfirmation(params.signerAddress, ownerSignature)]
    } else if (!hasOwnerConfirmation(confirmations, params.signerAddress)) {
      const ownerSignature = await params.signHash(safeTxHash)
      await params.txService.confirmTransaction(safeTxHash, ownerSignature)
      confirmations = mergeConfirmations(confirmations, [createLocalConfirmation(params.signerAddress, ownerSignature)])
    }

    confirmations = mergeConfirmations(
      confirmations,
      await readSafeLiteConfirmations(params.txService, safeTxHash, confirmations),
    )
    if (confirmations.length < account.threshold) {
      return {
        completedTxs,
        mode: "proposed",
        confirmations: confirmations.length,
        safeTxHash,
        threshold: account.threshold,
        txIndex,
        txLabel: tx.label,
      }
    }

    const execTx = buildSafeLiteExecTransaction({
      safeAddress: params.safeAddress,
      signatures: packSafeSignatures(confirmations, account.threshold),
      transaction: safeTransaction,
    })
    const hash = await params.sendTransaction(execTx, tx)
    lastHash = hash
    if (params.waitForReceipt) {
      const receipt = await params.waitForReceipt(hash, tx)
      if (receipt?.status !== "success") throw new Error(`Transaction failed: ${tx.label}`)
    }
    completedTxs += 1
  }

  if (!lastHash || !lastSafeTxHash) throw new Error("Safe plan has no executable transactions.")
  return {
    mode: "executed",
    completedTxs,
    hash: lastHash,
    safeTxHash: lastSafeTxHash,
    threshold: lastThreshold,
  }
}

export function normalizeSafeLitePersonalSignature(signature: Hex): Hex {
  return normalizePersonalSafeSignature(signature)
}

export function valueToRpcHex(value: bigint): Hex {
  return toHex(value)
}

function toSafeContractArgs(tx: SafeLiteTransaction) {
  return [
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    tx.safeTxGas,
    tx.baseGas,
    tx.gasPrice,
    tx.gasToken,
    tx.refundReceiver,
    tx.nonce,
  ] as const
}

async function readSafeLiteConfirmations(
  txService: SafeLiteTxService,
  safeTxHash: Hex,
  fallback: readonly SafeLiteConfirmation[] = [],
) {
  try {
    return readConfirmations(await txService.getTransactionConfirmations(safeTxHash))
  } catch (error) {
    if (fallback.length || isSafeTxNotFoundError(error)) return [...fallback]
    throw error
  }
}

function hasOwnerConfirmation(confirmations: readonly SafeLiteConfirmation[], owner: Address) {
  return confirmations.some((confirmation) => isAddressEqual(confirmation.owner, owner))
}

function createLocalConfirmation(owner: Address, signature: Hex): SafeLiteConfirmation {
  return {
    owner: getAddress(owner),
    signature,
  }
}

function mergeConfirmations(
  base: readonly SafeLiteConfirmation[],
  extra: readonly SafeLiteConfirmation[],
): SafeLiteConfirmation[] {
  const byOwner = new Map<string, SafeLiteConfirmation>()
  for (const confirmation of [...base, ...extra]) {
    byOwner.set(getAddress(confirmation.owner).toLowerCase(), {
      owner: getAddress(confirmation.owner),
      signature: confirmation.signature,
    })
  }
  return [...byOwner.values()]
}

function readConfirmations(value: unknown): SafeLiteConfirmation[] {
  if (!value || typeof value !== "object") return []
  const results = (value as { results?: unknown }).results
  const confirmations = Array.isArray(results) ? results : Array.isArray(value) ? value : []
  return confirmations.flatMap((confirmation) => {
    if (!confirmation || typeof confirmation !== "object") return []
    const owner = (confirmation as { owner?: unknown }).owner
    const signature = (confirmation as { signature?: unknown }).signature
    return typeof owner === "string" && typeof signature === "string"
      ? [{ owner: getAddress(owner), signature: signature as Hex }]
      : []
  })
}

function isSafeTxNotFoundError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "safe_tx_service_not_found"
}
