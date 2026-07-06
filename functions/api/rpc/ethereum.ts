import { handleEthereumRpcGatewayRequest } from "../../../src/server/rpcGateway"

export const onRequestPost: PagesFunction<{
  SAFECAFE_RPC_ALLOW_ALL_WALLETS?: string
  SAFECAFE_AUTH_SECRET?: string
  SAFECAFE_RPC_URL?: string
  SAFECAFE_RPC_URLS?: string
}> = async ({ request, env }) => handleEthereumRpcGatewayRequest(request, env)

export const onRequestGet: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  })
