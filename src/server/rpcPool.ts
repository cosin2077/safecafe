import type { RpcGatewayEnv } from "./serverEnv"

const CHAINLIST_URL = "https://chainid.network/chains.json"
const ETHEREUM_MAINNET_CHAIN_ID = 1
const poolCacheTtlMs = 24 * 60 * 60 * 1000 // 24 hours

type ChainEntry = {
  chainId: number
  rpc?: Array<string | { url: string }>
}

type PoolCache = {
  expiresAt: number
  urls: string[]
}

let poolCache: PoolCache | null = null

/**
 * Fetch Ethereum mainnet public RPCs from chainid.network.
 * Results are cached in-process for 24 hours.
 */
async function fetchChainRpcPool(): Promise<string[]> {
  if (poolCache && poolCache.expiresAt > Date.now()) return poolCache.urls

  try {
    const response = await fetch(CHAINLIST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return cachePool(getHardcodedPool())

    const chains = (await response.json()) as ChainEntry[]
    const ethChain = chains.find((c) => c.chainId === ETHEREUM_MAINNET_CHAIN_ID)
    if (!ethChain?.rpc?.length) return cachePool(getHardcodedPool())

    const urls = extractValidRpcs(ethChain.rpc)
    if (urls.length === 0) return cachePool(getHardcodedPool())

    return cachePool(urls)
  } catch {
    return cachePool(getHardcodedPool())
  }
}

function extractValidRpcs(rpcList: ChainEntry["rpc"]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of rpcList ?? []) {
    const url = typeof entry === "string" ? entry : entry?.url
    if (!url) continue
    if (seen.has(url)) continue
    // Server-side proxying should not use cleartext or WebSocket endpoints.
    if (!url.startsWith("https://")) continue
    // Skip template URLs requiring API keys
    if (url.includes("${")) continue
    seen.add(url)
    result.push(url)
  }
  return result
}

function cachePool(urls: string[]) {
  poolCache = { expiresAt: Date.now() + poolCacheTtlMs, urls }
  return urls
}

function getHardcodedPool(): string[] {
  return [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://mainnet.gateway.tenderly.co",
    "https://rpc.mevblocker.io",
  ]
}

/**
 * Build the full RPC URL list: env config → chainid.network pool → hardcoded fallback.
 * Env URLs always take priority. The pool is appended for failover.
 */
export async function rpcUrls(env: RpcGatewayEnv): Promise<string[]> {
  const envUrls = [
    ...(env.SAFECAFE_RPC_URLS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ...(env.SAFECAFE_RPC_URL ? [env.SAFECAFE_RPC_URL] : []),
  ]

  const pool = await fetchChainRpcPool()
  const envSet = new Set(envUrls.map((u) => u.toLowerCase()))

  return [...envUrls, ...pool.filter((u) => !envSet.has(u.toLowerCase()))]
}

export const rpcPoolTestHooks = {
  resetCache() {
    poolCache = null
  },
  getCacheState() {
    return poolCache ? { expiresAt: poolCache.expiresAt, count: poolCache.urls.length } : null
  },
}
