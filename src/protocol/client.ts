import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { ethereumMainnet } from "./chains"
import { DEFAULT_RPC_URLS } from "./contracts"

export type SafenetPublicClientOptions = {
  authToken?: string | null
  rpcUrl?: string
}

export function createSafenetPublicClient(options?: SafenetPublicClientOptions | string): PublicClient {
  const normalized = typeof options === "string" ? { rpcUrl: options } : (options ?? {})
  const gatewayTransport = normalized.authToken
    ? http("/api/rpc/ethereum", {
        fetchOptions: { headers: { authorization: `Bearer ${normalized.authToken}` } },
      })
    : null
  const transports = normalized.rpcUrl ? [http(normalized.rpcUrl)] : DEFAULT_RPC_URLS.map((url) => http(url))
  return createPublicClient({
    chain: ethereumMainnet,
    transport: gatewayTransport ?? fallback(transports),
  })
}
