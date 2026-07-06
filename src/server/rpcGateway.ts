import { hashMessage, isAddress } from "viem"
import { CHAIN_ID, CONTRACTS } from "../protocol/contracts"
import { rpcStrategy, verifyRpcAccess } from "./accessStrategy"
import {
  accountSubjectKind,
  authTtlSeconds,
  canUseAuthSecret,
  challengeTtlSeconds,
  createAuthMessage,
  createChallengeToken,
  createSessionToken,
  readAddress,
  readRpcSession,
  type SessionPayload,
  verifyChallengeToken,
  verifyWalletSignature,
} from "./authSession"
import { forwardRpcRequest, type JsonRpcRequest } from "./rpcUpstream"
import type { RpcGatewayEnv } from "./serverEnv"

export type { RpcGatewayEnv } from "./serverEnv"

const maxBodyBytes = 32_000
const allowedCallTargets = new Set<string>(
  [CONTRACTS.safeToken, CONTRACTS.staking, CONTRACTS.merkleDrop, CONTRACTS.multicall3].map((address) =>
    address.toLowerCase(),
  ),
)

export async function handleRpcChallengeRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (!canUseAuthSecret(env)) return json({ error: "RPC auth is not configured." }, 503)
  const body = await readJsonBody(request)
  if (body.status !== "ok") return json({ error: body.error }, body.status)
  const signer = readAddress(body.value, "signer") ?? readAddress(body.value, "address")
  if (!signer) return json({ error: "A valid signer address is required." }, 400)
  const subject = readAddress(body.value, "subject") ?? signer
  const subjectKind = accountSubjectKind(signer, subject)
  const chainId = readNumber(body.value, "chainId") ?? CHAIN_ID
  if (chainId !== CHAIN_ID) return json({ error: "Only Ethereum mainnet is supported." }, 400)
  const now = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomUUID()
  const message = createAuthMessage({
    signer,
    subject,
    subjectKind,
    chainId,
    domain: new URL(request.url).host,
    expirationTime: new Date((now + challengeTtlSeconds) * 1000).toISOString(),
    issuedAt: new Date(now * 1000).toISOString(),
    nonce,
    strategy: rpcStrategy(env),
  })
  const challenge = await createChallengeToken(
    {
      signer,
      subject,
      subjectKind,
      chainId,
      exp: now + challengeTtlSeconds,
      iat: now,
      messageHash: hashMessage(message),
      nonce,
    },
    env,
  )
  return json({
    challenge,
    expiresAt: now + challengeTtlSeconds,
    message,
    signer,
    subject,
    subjectKind,
    strategy: rpcStrategy(env),
  })
}

export async function handleRpcVerifyRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (!canUseAuthSecret(env)) return json({ error: "RPC auth is not configured." }, 503)
  const body = await readJsonBody(request)
  if (body.status !== "ok") return json({ error: body.error }, body.status)
  const signer = readAddress(body.value, "signer") ?? readAddress(body.value, "address")
  const subject = readAddress(body.value, "subject") ?? signer
  const challenge = readString(body.value, "challenge")
  const message = readString(body.value, "message")
  const signature = readString(body.value, "signature")
  if (!signer || !subject || !challenge || !message || !signature) {
    return json({ error: "signer, subject, challenge, message and signature are required." }, 400)
  }
  const challengePayload = await verifyChallengeToken(challenge, env)
  const challengeSigner = challengePayload?.signer ?? challengePayload?.address
  const challengeSubject = challengePayload?.subject ?? challengeSigner
  if (
    !challengePayload ||
    !challengeSigner ||
    !challengeSubject ||
    challengeSigner.toLowerCase() !== signer.toLowerCase() ||
    challengeSubject.toLowerCase() !== subject.toLowerCase()
  ) {
    return json({ error: "Invalid or expired challenge." }, 401)
  }
  if (challengePayload.messageHash !== hashMessage(message)) {
    return json({ error: "Challenge message does not match." }, 401)
  }
  const validSignature = await verifyWalletSignature({
    address: signer,
    env,
    message,
    signature: signature as `0x${string}`,
  })
  if (!validSignature) return json({ error: "Invalid wallet signature." }, 401)
  const eligible = await verifyRpcAccess({ signer, subject }, env)
  if (!eligible) return json({ error: "Wallet does not satisfy the SAFE access strategy." }, 403)
  const now = Math.floor(Date.now() / 1000)
  const session: SessionPayload = {
    address: signer,
    signer,
    subject,
    subjectKind: accountSubjectKind(signer, subject),
    chainId: CHAIN_ID,
    exp: now + authTtlSeconds,
    iat: now,
    strategy: rpcStrategy(env),
  }
  return json({
    address: signer,
    signer,
    subject,
    subjectKind: session.subjectKind,
    expiresAt: session.exp,
    strategy: session.strategy,
    token: await createSessionToken(session, env),
  })
}

export async function handleEthereumRpcGatewayRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  if (request.method !== "POST") return jsonRpcHttpError(null, -32600, "Only POST is supported.", 405)
  if (!canUseAuthSecret(env)) return jsonRpcHttpError(null, -32000, "RPC auth is not configured.", 503)
  const session = await readRpcSession(request, env)
  if (!session) return jsonRpcHttpError(null, -32001, "Authentication required.", 401)
  const eligible = await verifyRpcAccess({ signer: session.signer, subject: session.subject }, env)
  if (!eligible) return jsonRpcHttpError(null, -32003, "Wallet no longer satisfies access strategy.", 403)
  const body = await readJsonBody(request)
  if (body.status !== "ok") return jsonRpcHttpError(null, -32700, body.error, body.status)
  if (Array.isArray(body.value)) {
    if (body.value.length > 20) return jsonRpcHttpError(null, -32600, "Batch request is too large.", 413)
    const results = await Promise.all(body.value.map((item) => handleRpcItem(item, env)))
    return json(results, 200, "no-store")
  }
  return json(await handleRpcItem(body.value, env), 200, "no-store")
}

async function handleRpcItem(input: unknown, env: RpcGatewayEnv) {
  const request = input as JsonRpcRequest
  const id = isJsonRpcId(request?.id) ? request.id : null
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC request.")
  }
  const blocked = validateRpcRequest(request)
  if (blocked) return jsonRpcError(id, blocked.code, blocked.message)
  const upstream = await forwardRpcRequest(request, env)
  if (!upstream.ok) return jsonRpcError(id, -32002, upstream.error)
  return upstream.value
}

function validateRpcRequest(request: JsonRpcRequest): { code: number; message: string } | null {
  const method = request.method
  if (method === "eth_chainId" || method === "eth_blockNumber") return null
  if (
    method === "eth_getBalance" ||
    method === "eth_getBlockByNumber" ||
    method === "eth_getCode" ||
    method === "eth_getTransactionReceipt"
  ) {
    return null
  }
  if (method !== "eth_call") return { code: -32601, message: `Method is not allowed: ${method}` }
  if (!Array.isArray(request.params) || request.params.length < 1) {
    return { code: -32602, message: "eth_call params are required." }
  }
  const call = request.params[0] as { to?: unknown; data?: unknown }
  if (!call || typeof call.to !== "string" || !isAddress(call.to)) {
    return { code: -32602, message: "eth_call target is required." }
  }
  if (!allowedCallTargets.has(call.to.toLowerCase())) {
    return { code: -32602, message: "eth_call target is not allowed." }
  }
  if (typeof call.data === "string" && call.data.length > 20_000) {
    return { code: -32602, message: "eth_call data is too large." }
  }
  return null
}

async function readJsonBody(
  request: Request,
): Promise<{ status: "ok"; value: unknown } | { status: number; error: string }> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > maxBodyBytes) return { status: 413, error: "Request body is too large." }
  const raw = await request.text()
  if (raw.length > maxBodyBytes) return { status: 413, error: "Request body is too large." }
  try {
    return { status: "ok", value: raw ? JSON.parse(raw) : {} }
  } catch {
    return { status: 400, error: "Invalid JSON body." }
  }
}

function readString(value: unknown, key: string) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null
  return typeof raw === "string" ? raw : null
}

function readNumber(value: unknown, key: string) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null
}

function isJsonRpcId(value: unknown) {
  return typeof value === "string" || typeof value === "number" || value === null
}

function json(payload: unknown, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "cache-control": cacheControl, "content-type": "application/json; charset=utf-8" },
  })
}

function jsonRpcHttpError(id: unknown, code: number, message: string, status: number) {
  return json(jsonRpcError(id, code, message), status, "no-store")
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: "2.0" }
}
