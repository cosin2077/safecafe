import { writeFileSync } from "node:fs"
import { createWalletClient, http, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { mainnet } from "viem/chains"
import {
  DEFAULT_RPC_URLS,
  compactAddress,
  createSafenetPublicClient,
  toSafeTransactionPayload,
  type TxPlan,
} from "../protocol"
import { bigintReplacer, resolveEnvValue, stringifyBigInts } from "./utils"

export type CliGlobalOptions = {
  rpc?: string
  json?: boolean
  mock?: boolean
}

export type SendPlanOptions = {
  privateKey: Hex
  rpcUrl?: string
  onSubmitted?: (label: string, hash: Hex) => void
  onConfirmed?: (label: string, blockNumber: bigint) => void
}

export function resolveRpcUrl(
  globals: Pick<CliGlobalOptions, "rpc">,
  env: Record<string, string | undefined>,
  envNames: readonly string[],
) {
  return globals.rpc || resolveEnvValue(env, envNames)
}

export function createProductPublicClient(
  globals: Pick<CliGlobalOptions, "rpc">,
  env: Record<string, string | undefined>,
  envNames: readonly string[],
) {
  return createSafenetPublicClient(resolveRpcUrl(globals, env, envNames))
}

export function readPrivateKey(envName: string | undefined, env: Record<string, string | undefined>): Hex {
  if (!envName) throw new Error("--private-key-env is required with --send")
  const privateKey = env[envName] as Hex | undefined
  if (!privateKey) throw new Error(`Missing private key in ${envName}`)
  return privateKey
}

export function output(globals: Pick<CliGlobalOptions, "json">, payload: unknown, printText: () => void) {
  if (globals.json) {
    console.log(stringifyBigInts(payload))
    return
  }
  printText()
}

export function printPlan(plan: TxPlan) {
  console.log(`Plan: ${plan.title}`)
  if (plan.account) console.log(`Account: ${plan.account}`)
  console.log("")
  plan.txs.forEach((tx, index) => {
    console.log(`${index + 1}. ${tx.label}`)
    console.log(`   to:   ${tx.to}`)
    console.log(`   data: ${compactAddress(tx.data, 18, 12)}`)
  })
  if (plan.warnings.length) {
    console.log("")
    plan.warnings.forEach((warning) => console.log(`Warning: ${warning}`))
  }
}

export function writeSafePayloadFile(plan: TxPlan, path: string, description: string, chainId = 1) {
  const payload = toSafeTransactionPayload(plan, chainId, { description })
  writeFileSync(path, JSON.stringify(payload, bigintReplacer, 2))
  return payload
}

export async function sendPlanTransactions(plan: TxPlan, options: SendPlanOptions) {
  const account = privateKeyToAccount(options.privateKey)
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(options.rpcUrl || DEFAULT_RPC_URLS[0]),
  })
  const publicClient = createSafenetPublicClient(options.rpcUrl)

  for (const tx of plan.txs) {
    const hash = await walletClient.sendTransaction({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })
    options.onSubmitted?.(tx.label, hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    options.onConfirmed?.(tx.label, receipt.blockNumber)
  }
}
