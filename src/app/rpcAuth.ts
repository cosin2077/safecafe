import type { Address } from "viem"
import { CHAIN_ID } from "../protocol"
import type { WalletIdentity } from "./walletIdentity"

const storageKey = "safecafe:rpc-session"

type StoredRpcSession = {
  address: Address
  expiresAt: number
  signer: Address
  subject: Address
  subjectKind: WalletIdentity["subjectKind"]
  token: string
}

type ChallengeResponse = {
  challenge: string
  message: string
}

type VerifyResponse = {
  address: Address
  expiresAt: number
  signer: Address
  subject: Address
  subjectKind: WalletIdentity["subjectKind"]
  token: string
}

export function readRpcSession(identity: WalletIdentity | Address | null): StoredRpcSession | null {
  const normalized = normalizeIdentity(identity)
  if (!normalized.signer || !normalized.subject) return null
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<StoredRpcSession> | null
    if (!parsed?.token || !parsed.expiresAt) return null
    const parsedSigner = parsed.signer ?? parsed.address
    const parsedSubject = parsed.subject ?? parsedSigner
    if (!parsedSigner || !parsedSubject) return null
    if (parsedSigner.toLowerCase() !== normalized.signer.toLowerCase()) return null
    if (parsedSubject.toLowerCase() !== normalized.subject.toLowerCase()) return null
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000) + 30) return null
    return {
      address: parsed.address ?? parsedSigner,
      expiresAt: parsed.expiresAt,
      signer: parsedSigner,
      subject: parsedSubject,
      subjectKind: parsed.subjectKind ?? normalized.subjectKind,
      token: parsed.token,
    }
  } catch {
    return null
  }
}

export function clearRpcSession() {
  window.localStorage.removeItem(storageKey)
}

export async function ensureRpcSession(
  identity: WalletIdentity | Address,
  ethereum: EthereumProvider,
): Promise<StoredRpcSession | null> {
  const normalized = normalizeIdentity(identity)
  if (!normalized.signer || !normalized.subject) return null
  const cached = readRpcSession(normalized)
  if (cached) return cached
  const challengeResponse = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, signer: normalized.signer, subject: normalized.subject }),
  })
  if (!challengeResponse.ok) return null
  const challenge = (await challengeResponse.json()) as ChallengeResponse
  const signature = (await ethereum.request({
    method: "personal_sign",
    params: [challenge.message, normalized.signer],
  })) as string
  const verifyResponse = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: challenge.challenge,
      message: challenge.message,
      signature,
      signer: normalized.signer,
      subject: normalized.subject,
    }),
  })
  if (!verifyResponse.ok) return null
  const session = (await verifyResponse.json()) as StoredRpcSession
  window.localStorage.setItem(storageKey, JSON.stringify(session satisfies VerifyResponse))
  return session
}

function normalizeIdentity(identity: WalletIdentity | Address | null): WalletIdentity {
  if (typeof identity === "string") {
    return { signer: identity, subject: identity, subjectKind: "self" }
  }
  return identity ?? { signer: null, subject: null, subjectKind: "self" }
}
