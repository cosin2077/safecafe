import { DEFAULT_RPC_URLS } from "../protocol/contracts"
import type { RpcGatewayEnv } from "./serverEnv"

export type JsonRpcRequest = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export function rpcUrls(env: RpcGatewayEnv) {
  return [
    ...(env.SAFECAFE_RPC_URLS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ...(env.SAFECAFE_RPC_URL ? [env.SAFECAFE_RPC_URL] : []),
    ...DEFAULT_RPC_URLS,
  ]
}

export async function forwardRpcRequest(
  request: JsonRpcRequest,
  env: RpcGatewayEnv,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const urls = rpcUrls(env)
  let lastError = "No RPC upstream is configured."
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        lastError = `RPC upstream returned HTTP ${response.status}.`
        continue
      }
      return { ok: true, value: await response.json() }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "RPC upstream failed."
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError }
}
