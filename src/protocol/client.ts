import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { ethereumMainnet } from "./chains"
import { DEFAULT_RPC_URLS } from "./contracts"

export function createSafenetPublicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: ethereumMainnet,
    transport: rpcUrl ? http(rpcUrl) : fallback(DEFAULT_RPC_URLS.map((url) => http(url))),
  })
}
