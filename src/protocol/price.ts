import { CONTRACTS } from "./contracts"

export const SAFE_PRICE_CACHE_MS = 60 * 60 * 1000
export const SAFE_PRICE_SOURCE = "Market data"

type CoinGeckoTokenPrice = Record<string, { usd?: number; last_updated_at?: number }>
type DefiLlamaTokenPrice = {
  coins?: Record<string, { price?: number; timestamp?: number }>
}

export type SafePriceResult = {
  source: string
  usd: number
  fetchedAt: number
}

export async function fetchSafeUsdPriceFromCoinGecko(): Promise<SafePriceResult> {
  try {
    return await fetchSafeUsdPriceFromCoinGeckoOnly()
  } catch {
    return fetchSafeUsdPriceFromDefiLlama()
  }
}

async function fetchSafeUsdPriceFromCoinGeckoOnly(): Promise<SafePriceResult> {
  const contract = CONTRACTS.safeToken.toLowerCase()
  const url = new URL("https://api.coingecko.com/api/v3/simple/token_price/ethereum")
  url.searchParams.set("contract_addresses", contract)
  url.searchParams.set("vs_currencies", "usd")
  url.searchParams.set("include_last_updated_at", "true")

  const response = await fetch(url)
  if (!response.ok) throw new Error(`SAFE price request failed: ${response.status}`)

  const data = (await response.json()) as CoinGeckoTokenPrice
  const price = data[contract]?.usd
  const lastUpdatedAt = data[contract]?.last_updated_at
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("SAFE price response did not include a valid USD price.")
  }

  return {
    source: "CoinGecko",
    usd: price,
    fetchedAt: typeof lastUpdatedAt === "number" ? lastUpdatedAt * 1000 : Date.now(),
  }
}

async function fetchSafeUsdPriceFromDefiLlama(): Promise<SafePriceResult> {
  const coinId = `ethereum:${CONTRACTS.safeToken}`
  const response = await fetch(`https://coins.llama.fi/prices/current/${coinId}`)
  if (!response.ok) throw new Error(`SAFE price request failed: ${response.status}`)

  const data = (await response.json()) as DefiLlamaTokenPrice
  const price = data.coins?.[coinId]?.price
  const timestamp = data.coins?.[coinId]?.timestamp
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error("SAFE price response did not include a valid USD price.")
  }

  return {
    source: "DefiLlama",
    usd: price,
    fetchedAt: typeof timestamp === "number" ? timestamp * 1000 : Date.now(),
  }
}
