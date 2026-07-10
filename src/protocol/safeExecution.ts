import { buildSafeLiteDirectExecTransaction } from "@safecafe/safe-lite"
import { type Address, getAddress, type Hex, isAddressEqual, type PublicClient } from "viem"
import { safeAccountAbi } from "./abi"
import type { PlannedTx } from "./txPlan"

export type SafeExecutionMode =
  | { kind: "direct"; threshold: bigint }
  | { kind: "not-owner"; threshold: bigint }
  | { kind: "multi-owner"; owners: Address[]; threshold: bigint }

export async function resolveSafeExecutionMode(params: {
  client: PublicClient
  safe: Address
  signer: Address
}): Promise<SafeExecutionMode> {
  const [owners, threshold] = await Promise.all([
    params.client.readContract({
      address: params.safe,
      abi: safeAccountAbi,
      functionName: "getOwners",
    }),
    params.client.readContract({
      address: params.safe,
      abi: safeAccountAbi,
      functionName: "getThreshold",
    }),
  ])
  const normalizedOwners = owners.map((owner) => getAddress(owner))
  if (!normalizedOwners.some((owner) => isAddressEqual(owner, params.signer))) return { kind: "not-owner", threshold }
  if (threshold === 1n) return { kind: "direct", threshold }
  return { kind: "multi-owner", owners: normalizedOwners, threshold }
}

export async function buildSafeExecTransaction(params: {
  client: PublicClient
  safe: Address
  signer: Address
  tx: PlannedTx
}): Promise<{
  to: Address
  data: Hex
  value: bigint
}> {
  const nonce = await params.client.readContract({
    address: params.safe,
    abi: safeAccountAbi,
    functionName: "nonce",
  })
  return buildSafeLiteDirectExecTransaction({
    nonce,
    safeAddress: params.safe,
    signerAddress: params.signer,
    tx: params.tx,
  })
}
