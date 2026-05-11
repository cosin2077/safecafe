export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type CacheableSafePrice = {
  usd: number
  source: string
  fetchedAt: number
}

export type CachedSafePriceState = {
  usd: number | null
  source: string
  fetchedAt: number | null
  stale: boolean
  error: string
}

export function createPathMap<const T extends readonly string[]>(items: T) {
  return Object.fromEntries(items.map((item) => [item, `/${item}`])) as Record<T[number], string>
}

export function navFromPath<const T extends readonly string[]>(
  pathname: string,
  items: T,
  paths: Record<T[number], string>,
  fallback: T[number],
): T[number] {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  for (const item of items as readonly T[number][]) {
    if (paths[item] === normalized) return item
  }
  return fallback
}

export function readCachedSafePrice(
  storage: StorageLike | undefined,
  key: string,
  fallbackSource: string,
  cacheMs?: number,
): CachedSafePriceState {
  if (!storage) return emptyPrice(fallbackSource)

  try {
    const raw = storage.getItem(key)
    if (!raw) return emptyPrice(fallbackSource)
    const parsed = JSON.parse(raw) as CacheableSafePrice
    if (typeof parsed.usd !== "number" || typeof parsed.fetchedAt !== "number") return emptyPrice(fallbackSource)
    return {
      usd: parsed.usd,
      source: parsed.source || fallbackSource,
      fetchedAt: parsed.fetchedAt,
      stale: cacheMs === undefined ? true : Date.now() - parsed.fetchedAt >= cacheMs,
      error: "",
    }
  } catch {
    return emptyPrice(fallbackSource)
  }
}

export function writeCachedSafePrice(storage: StorageLike | undefined, key: string, price: CacheableSafePrice) {
  if (!storage) return
  storage.setItem(key, JSON.stringify(price))
}

function emptyPrice(source: string): CachedSafePriceState {
  return {
    usd: null,
    source,
    fetchedAt: null,
    stale: false,
    error: "",
  }
}
