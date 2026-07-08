import { handleSafeDiscoveryRequest } from "../../src/server/safeDiscovery"
import type { RpcGatewayEnv } from "../../src/server/serverEnv"

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafeDiscoveryRequest(request, env)

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafeDiscoveryRequest(request, env)
