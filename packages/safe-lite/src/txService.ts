import type { Address, Hex } from "viem"
import type { SafeLiteServiceTransactionData, SafeLiteTxService } from "./types.js"

export type SafeTxErrorCode =
  | "safe_api_key_invalid"
  | "safe_api_key_missing"
  | "safe_tx_auth_mismatch"
  | "safe_tx_auth_required"
  | "safe_tx_service_failed"
  | "safe_tx_service_not_found"
  | "safe_tx_service_rate_limited"

export type SafeTxErrorMessages = Partial<
  Record<Exclude<SafeTxErrorCode, "safe_tx_auth_mismatch" | "safe_tx_service_not_found">, string>
>

export class SafeTxServiceError extends Error {
  readonly code: SafeTxErrorCode

  constructor(code: SafeTxErrorCode, message: string) {
    super(message)
    this.name = "SafeTxServiceError"
    this.code = code
  }
}

export class DirectSafeTxServiceClient implements SafeLiteTxService {
  readonly #apiKey?: string
  readonly #baseUrl: string
  readonly #messages?: SafeTxErrorMessages

  constructor(config: { apiKey?: string; baseUrl: string; messages?: SafeTxErrorMessages }) {
    this.#apiKey = config.apiKey?.trim() || undefined
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.#messages = config.messages
  }

  async confirmTransaction(safeTxHash: Hex, signature: Hex) {
    return this.#request({
      body: { signature },
      method: "POST",
      url: `${this.#baseUrl}/v1/multisig-transactions/${safeTxHash}/confirmations/`,
    })
  }

  async getTransactionConfirmations(safeTxHash: Hex) {
    return this.#request({
      method: "GET",
      url: `${this.#baseUrl}/v1/multisig-transactions/${safeTxHash}/confirmations/`,
    })
  }

  async proposeTransaction(input: {
    origin?: string
    safeAddress: Address
    safeTransactionData: SafeLiteServiceTransactionData
    safeTxHash: Hex
    senderAddress: Address
    senderSignature: Hex
  }) {
    await this.#request({
      body: {
        ...input.safeTransactionData,
        contractTransactionHash: input.safeTxHash,
        origin: input.origin,
        sender: input.senderAddress,
        signature: input.senderSignature,
      },
      method: "POST",
      url: `${this.#baseUrl}/v2/safes/${input.safeAddress}/multisig-transactions/`,
    })
  }

  async #request(request: { body?: unknown; method: string; url: string }) {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        "content-type": "application/json",
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    })
    return readSafeTxResponse(response, this.#messages)
  }
}

export class ProxiedSafeTxServiceClient implements SafeLiteTxService {
  readonly #authToken?: string | null
  readonly #messages?: SafeTxErrorMessages
  readonly #safeAddress: Address
  readonly #senderAddress: Address

  constructor(config: {
    authToken?: string | null
    messages?: SafeTxErrorMessages
    safeAddress: Address
    senderAddress: Address
  }) {
    this.#authToken = config.authToken
    this.#messages = config.messages
    this.#safeAddress = config.safeAddress
    this.#senderAddress = config.senderAddress
  }

  confirmTransaction(safeTxHash: Hex, signature: Hex) {
    return this.#request({ action: "confirm", safeTxHash, signature })
  }

  getTransactionConfirmations(safeTxHash: Hex) {
    return this.#request({ action: "confirmations", safeTxHash })
  }

  async proposeTransaction(input: {
    origin?: string
    safeAddress: Address
    safeTransactionData: SafeLiteServiceTransactionData
    safeTxHash: Hex
    senderAddress: Address
    senderSignature: Hex
  }) {
    await this.#request({
      action: "propose",
      origin: input.origin,
      safeAddress: input.safeAddress,
      safeTransactionData: input.safeTransactionData,
      safeTxHash: input.safeTxHash,
      senderAddress: input.senderAddress,
      senderSignature: input.senderSignature,
    })
  }

  async #request(body: Record<string, unknown>) {
    const response = await fetch("/api/safe/transaction", {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(this.#authToken ? { authorization: `Bearer ${this.#authToken}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        safeAddress: this.#safeAddress,
        senderAddress: this.#senderAddress,
        ...body,
      }),
    })
    const payload = await readSafeTxResponse(response, this.#messages)
    return readProxyResult(payload)
  }
}

export function safeTxServiceUrl(chainId = 1n) {
  if (chainId === 1n) return "https://api.safe.global/tx-service/eth/api"
  throw new SafeTxServiceError("safe_tx_service_failed", `Unsupported Safe Transaction Service chainId ${chainId}.`)
}

export async function readSafeTxResponse(response: Response, messages?: SafeTxErrorMessages) {
  const text = await response.text()
  const payload = parseJson(text)
  if (response.ok) return payload
  const code = readSafeTxErrorCode(payload, response.status)
  const message =
    readConfiguredSafeTxErrorMessage(messages, code) ??
    readSafeTxErrorMessage(payload) ??
    defaultSafeTxErrorMessage(code)
  throw new SafeTxServiceError(code, message)
}

function readProxyResult(payload: unknown) {
  if (payload && typeof payload === "object" && "result" in payload) return (payload as { result: unknown }).result
  return payload
}

function parseJson(text: string) {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readSafeTxErrorCode(payload: unknown, status: number): SafeTxErrorCode {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code
      if (isSafeTxErrorCode(code)) return code
    }
  }
  if (status === 401 || status === 403) return "safe_api_key_invalid"
  if (status === 404) return "safe_tx_service_not_found"
  if (status === 429) return "safe_tx_service_rate_limited"
  return "safe_tx_service_failed"
}

function readSafeTxErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null
  const error = "error" in payload ? (payload as { error?: unknown }).error : payload
  if (!error || typeof error !== "object") return null
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message : null
}

function isSafeTxErrorCode(value: unknown): value is SafeTxErrorCode {
  return (
    value === "safe_api_key_invalid" ||
    value === "safe_api_key_missing" ||
    value === "safe_tx_auth_mismatch" ||
    value === "safe_tx_auth_required" ||
    value === "safe_tx_service_failed" ||
    value === "safe_tx_service_not_found" ||
    value === "safe_tx_service_rate_limited"
  )
}

function readConfiguredSafeTxErrorMessage(messages: SafeTxErrorMessages | undefined, code: SafeTxErrorCode) {
  if (code === "safe_tx_service_not_found") return null
  if (code === "safe_tx_auth_mismatch") return null
  return messages?.[code] ?? null
}

function defaultSafeTxErrorMessage(code: SafeTxErrorCode) {
  if (code === "safe_api_key_missing") {
    return "Safe API key is not configured. Add your own Safe API key in Settings, or use your own Safe API key."
  }
  if (code === "safe_api_key_invalid") {
    return "Safe API key is invalid or not allowed. Update the Safe API key in Settings."
  }
  if (code === "safe_tx_service_rate_limited") {
    return "Safe Transaction Service is rate limited. Try again later or use your own Safe API key in Settings."
  }
  if (code === "safe_tx_service_not_found") return "Safe transaction was not found."
  if (code === "safe_tx_auth_required") return "Sign in with your wallet before syncing the Safe proposal."
  if (code === "safe_tx_auth_mismatch") return "The Safe proposal does not match the signed wallet session."
  return "Safe Transaction Service is unavailable. Try again later or use your own Safe API key."
}
