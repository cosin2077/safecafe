import { readFileSync } from "node:fs"
import { stdin as input, stdout as outputStream } from "node:process"
import { createInterface } from "node:readline/promises"
import {
  DirectSafeTxServiceClient,
  normalizeSafeLitePersonalSignature,
  readSafeLiteAccount,
  type SafeLiteSendTransaction,
  type SafeLiteSignHash,
  type SafeLiteTxService,
  type SafeLiteWaitForReceipt,
  safeTxServiceUrl,
  submitSafeLitePlan,
} from "@safecafe/safe-lite"
import { type Address, createWalletClient, type Hex, http, type PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { compactAddress, createSafenetPublicClient, DEFAULT_RPC_URLS, type TxPlan } from "../protocol"
import { ethereumMainnet } from "../protocol/chains"
import { parseAddress, resolveEnvValue, stringifyBigInts } from "./utils"

export type CliGlobalOptions = {
  rpc?: string
  json?: boolean
  mock?: boolean
}

export type SigningOptions = {
  privateKeyPrompt?: boolean
  privateKeyStdin?: boolean
  privateKeyEnv?: string
  signer?: string
}

export type SigningKey = {
  privateKey: Hex
  address: Address
  source: string
}

type SafeInfoReader = (input: { safeAddress: Address; signerAddress: Address; rpcUrl?: string }) => Promise<{
  isOwner: boolean
  threshold: number
}>

export type SendPlanOptions = {
  privateKey: Hex
  rpcUrl?: string
  safeApiKeys?: readonly string[]
  safeTxServiceUrl?: string
  createSafeInfoReader?: SafeInfoReader
  createSafeTxService?: (config: { apiKey?: string; txServiceUrl?: string }) => SafeLiteTxService
  safePublicClient?: PublicClient
  sendSafeTransaction?: SafeLiteSendTransaction
  signSafeHash?: SafeLiteSignHash
  waitForSafeReceipt?: SafeLiteWaitForReceipt
  onSubmitted?: (label: string, hash: Hex) => void
  onConfirmed?: (label: string, blockNumber: bigint) => void
}

export type PlanSendResult =
  | { mode: "eoa-executed" }
  | { mode: "safe-executed"; safeTxHash: string; threshold: number }
  | { mode: "safe-proposed"; safeTxHash: string; confirmations: number; threshold: number }

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

export function output(globals: Pick<CliGlobalOptions, "json">, payload: unknown, printText: () => void) {
  if (globals.json) {
    console.log(stringifyBigInts(payload))
    return
  }
  printText()
}

export async function readSigningPrivateKey(
  options: SigningOptions,
  env: Record<string, string | undefined>,
): Promise<Hex> {
  const keys = await readSigningKeyring(options, env)
  if (keys.length !== 1) {
    const addresses = keys.map((key) => key.address).join(", ")
    throw new Error(
      `Signing source resolved to ${keys.length} keys (${addresses}). Use --signer <address> or a single-key source.`,
    )
  }
  return keys[0].privateKey
}

export async function readSigningKeyring(
  options: SigningOptions,
  env: Record<string, string | undefined>,
): Promise<SigningKey[]> {
  const sourceCount =
    Number(!!options.privateKeyPrompt) + Number(!!options.privateKeyStdin) + Number(!!options.privateKeyEnv)
  if (sourceCount > 1) {
    throw new Error(
      "Choose exactly one signing key source: --private-key-prompt, --private-key-stdin, or --private-key-env <name>.",
    )
  }

  if (sourceCount === 0) {
    const defaultKeys = readDefaultSigningKeys(env)
    if (defaultKeys.length) return defaultKeys
    throw new Error(
      "Choose exactly one signing key source: --private-key-prompt, --private-key-stdin, or --private-key-env <name>.",
    )
  }

  if (options.privateKeyPrompt) {
    return [createSigningKey(normalizePrivateKey(await promptHidden("Private key (input hidden): ")), "prompt")]
  }
  if (options.privateKeyStdin) {
    return parsePrivateKeyList(readFileSync(0, "utf8"), "stdin")
  }

  const value = options.privateKeyEnv ? env[options.privateKeyEnv] : undefined
  if (!value) throw new Error(`Missing private key in ${options.privateKeyEnv}`)
  return parsePrivateKeyList(value, `env:${options.privateKeyEnv}`)
}

async function promptHidden(prompt: string): Promise<string> {
  if (!input.isTTY) throw new Error("--private-key-prompt requires an interactive terminal")

  const rl = createInterface({ input, output: outputStream })
  const hidden = rl as unknown as { _writeToOutput: (text: string) => void }
  hidden._writeToOutput = (text: string) => {
    if (text.includes(prompt)) outputStream.write(prompt)
  }

  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
    outputStream.write("\n")
  }
}

function normalizePrivateKey(value: string): Hex {
  const privateKey = value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string.")
  }
  return privateKey as Hex
}

export function resolvePreferredSignerAddress(
  options: Pick<SigningOptions, "signer">,
  env: Record<string, string | undefined>,
): Address | undefined {
  const value = options.signer || env.SAFECAFE_CLI_SIGNER_ADDRESS
  return value ? parseAddress(value, "signer") : undefined
}

export function selectEoaSigningKey(
  keys: readonly SigningKey[],
  account: Address,
  preferredSigner?: Address,
): SigningKey {
  if (preferredSigner && preferredSigner.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Signer ${preferredSigner} does not match EOA account ${account}.`)
  }

  const matches = keys.filter((key) => key.address.toLowerCase() === account.toLowerCase())
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return matches[0]

  const available = keys.map((key) => key.address).join(", ")
  throw new Error(`No signing key matches EOA account ${account}. Available signers: ${available}.`)
}

export async function selectSafeSigningKey(
  keys: readonly SigningKey[],
  options: {
    safeAddress: Address
    preferredSigner?: Address
    rpcUrl?: string
    createSafeInfoReader?: SafeInfoReader
  },
): Promise<SigningKey> {
  const readInfo = options.createSafeInfoReader ?? createDefaultSafeInfoReader

  if (options.preferredSigner) {
    const preferredSigner = options.preferredSigner
    const key = keys.find((candidate) => candidate.address.toLowerCase() === preferredSigner.toLowerCase())
    if (!key) {
      const available = keys.map((candidate) => candidate.address).join(", ")
      throw new Error(
        `Signer ${preferredSigner} is not present in the configured keyring. Available signers: ${available}.`,
      )
    }
    const info = await readInfo({
      safeAddress: options.safeAddress,
      signerAddress: key.address,
      rpcUrl: options.rpcUrl,
    })
    if (!info.isOwner) {
      throw new Error(`Signer ${key.address} is not an owner of Safe ${options.safeAddress}.`)
    }
    return key
  }

  const owners: SigningKey[] = []
  for (const key of keys) {
    const info = await readInfo({
      safeAddress: options.safeAddress,
      signerAddress: key.address,
      rpcUrl: options.rpcUrl,
    })
    if (info.isOwner) owners.push(key)
  }

  if (owners.length === 1) return owners[0]
  if (owners.length === 0) {
    const available = keys.map((key) => key.address).join(", ")
    throw new Error(`No configured signer is an owner of Safe ${options.safeAddress}. Available signers: ${available}.`)
  }

  const candidates = owners.map((key) => key.address).join(", ")
  throw new Error(
    `Multiple configured signers can operate Safe ${options.safeAddress}: ${candidates}. Use --signer <address> or SAFECAFE_CLI_SIGNER_ADDRESS to choose one.`,
  )
}

async function createDefaultSafeInfoReader(input: {
  safeAddress: Address
  signerAddress: Address
  rpcUrl?: string
}): Promise<{ isOwner: boolean; threshold: number }> {
  const info = await readSafeLiteAccount({
    client: createSafenetPublicClient(input.rpcUrl),
    safeAddress: input.safeAddress,
    signerAddress: input.signerAddress,
  })
  return { isOwner: info.isOwner, threshold: info.threshold }
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
    for (const warning of plan.warnings) {
      console.log(`Warning: ${warning}`)
    }
  }
}

export async function sendPlanTransactions(plan: TxPlan, options: SendPlanOptions): Promise<PlanSendResult> {
  const account = privateKeyToAccount(options.privateKey)
  const rpcUrl = options.rpcUrl || DEFAULT_RPC_URLS[0]
  const walletClient = createWalletClient({
    account,
    chain: ethereumMainnet,
    transport: http(rpcUrl),
  })
  const publicClient = createSafenetPublicClient(rpcUrl)

  for (const tx of plan.txs) {
    const hash = await walletClient.sendTransaction({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })
    options.onSubmitted?.(tx.label, hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    assertSuccessfulReceipt(tx.label, receipt)
    options.onConfirmed?.(tx.label, receipt.blockNumber)
  }
  return { mode: "eoa-executed" }
}

export async function sendSafePlanTransactions(plan: TxPlan, options: SendPlanOptions): Promise<PlanSendResult> {
  if (!plan.account) throw new Error("Safe execution requires a staking account address.")

  const signer = privateKeyToAccount(options.privateKey)
  const rpcUrl = options.rpcUrl || DEFAULT_RPC_URLS[0]
  const publicClient = options.safePublicClient ?? createSafenetPublicClient(rpcUrl)
  const safeInfo = await readSafeLiteAccount({
    client: publicClient,
    safeAddress: plan.account,
    signerAddress: signer.address,
  })

  if (!safeInfo.isOwner) {
    throw new Error(`Signing key ${signer.address} is not an owner of Safe ${plan.account}.`)
  }

  const txService = (options.createSafeTxService ?? createDefaultSafeTxService)({
    apiKey: selectSafeApiKey(options.safeApiKeys),
    txServiceUrl: options.safeTxServiceUrl,
  })
  const result = await submitSafeLitePlan({
    client: publicClient,
    origin: "Safecafe CLI",
    safeAddress: plan.account,
    signerAddress: signer.address,
    txService,
    txs: plan.txs,
    signHash:
      options.signSafeHash ??
      (async (safeTxHash) =>
        normalizeSafeLitePersonalSignature(await signer.signMessage({ message: { raw: safeTxHash } }))),
    sendTransaction:
      options.sendSafeTransaction ??
      (async (transaction, tx) => {
        const walletClient = createWalletClient({
          account: signer,
          chain: ethereumMainnet,
          transport: http(rpcUrl),
        })
        const hash = await walletClient.sendTransaction({
          account: signer,
          chain: ethereumMainnet,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        })
        options.onSubmitted?.(tx.label, hash)
        return hash
      }),
    waitForReceipt:
      options.waitForSafeReceipt ??
      (async (hash, tx) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        assertSuccessfulReceipt(tx.label, receipt)
        options.onConfirmed?.(tx.label, receipt.blockNumber)
        return receipt
      }),
  })

  if (result.mode === "proposed") {
    return {
      mode: "safe-proposed",
      confirmations: result.confirmations,
      safeTxHash: result.safeTxHash,
      threshold: result.threshold,
    }
  }

  return { mode: "safe-executed", safeTxHash: result.safeTxHash, threshold: result.threshold }
}

function selectSafeApiKey(keys: readonly string[] | undefined) {
  const available = keys?.map((key) => key.trim()).filter(Boolean) ?? []
  return available[0]
}

function createDefaultSafeTxService(config: { apiKey?: string; txServiceUrl?: string }) {
  return new DirectSafeTxServiceClient({
    apiKey: config.apiKey,
    baseUrl: config.txServiceUrl?.trim() || safeTxServiceUrl(1n),
  })
}

export function assertSuccessfulReceipt(label: string, receipt: { status?: string; blockNumber: bigint }) {
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${label}`)
}

function readDefaultSigningKeys(env: Record<string, string | undefined>) {
  const keyring: SigningKey[] = []
  const seen = new Set<string>()

  const inlineSources = [
    ["SAFECAFE_CLI_PRIVATE_KEY", env.SAFECAFE_CLI_PRIVATE_KEY],
    ["SAFECAFE_CLI_PRIVATE_KEYS", env.SAFECAFE_CLI_PRIVATE_KEYS],
  ] as const
  for (const [label, value] of inlineSources) {
    if (!value) continue
    for (const key of parsePrivateKeyList(value, `env:${label}`)) {
      pushSigningKey(keyring, seen, key)
    }
  }

  const fileSources = [
    ["SAFECAFE_CLI_PRIVATE_KEY_FILE", env.SAFECAFE_CLI_PRIVATE_KEY_FILE],
    ["SAFECAFE_CLI_PRIVATE_KEY_FILES", env.SAFECAFE_CLI_PRIVATE_KEY_FILES],
  ] as const
  for (const [label, value] of fileSources) {
    if (!value) continue
    for (const path of splitList(value)) {
      const content = readFileSync(path, "utf8")
      for (const key of parsePrivateKeyList(content, `${label}:${path}`)) {
        pushSigningKey(keyring, seen, key)
      }
    }
  }

  return keyring
}

function parsePrivateKeyList(value: string, source: string) {
  return splitList(value).map((entry, index) => createSigningKey(normalizePrivateKey(entry), `${source}#${index + 1}`))
}

function createSigningKey(privateKey: Hex, source: string): SigningKey {
  return {
    address: privateKeyToAccount(privateKey).address,
    privateKey,
    source,
  }
}

function pushSigningKey(target: SigningKey[], seen: Set<string>, key: SigningKey) {
  const id = key.privateKey.toLowerCase()
  if (seen.has(id)) return
  seen.add(id)
  target.push(key)
}

function splitList(value: string) {
  return value
    .split(/[\n,\r\t ]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}
