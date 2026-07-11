import { SAFE_PRICE_SOURCE, type SafePriceResult } from "../protocol"
import { apiUrl } from "../shared/apiUrl"

export async function fetchSafeUsdPrice(): Promise<SafePriceResult> {
  const response = await fetch(apiUrl("/api/price/safe", import.meta.env.VITE_API_BASE_URL))
  if (!response.ok) throw new Error(`SAFE price request failed: ${response.status}`)

  const data = (await response.json()) as Partial<SafePriceResult>
  if (typeof data.usd !== "number" || !Number.isFinite(data.usd) || data.usd <= 0) {
    throw new Error("SAFE price response did not include a valid USD price.")
  }

  return {
    source: typeof data.source === "string" && data.source.trim() ? data.source : SAFE_PRICE_SOURCE,
    usd: data.usd,
    fetchedAt: typeof data.fetchedAt === "number" ? data.fetchedAt : Date.now(),
  }
}
