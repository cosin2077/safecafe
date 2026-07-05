import type { AgentContext } from "./types"

export type AgentChatRole = "assistant" | "user"

export type AgentChatRequest = {
  message: string
  messages: Array<{ role: AgentChatRole; content: string }>
  context: Pick<AgentContext, "account" | "chainId"> & {
    liveBlock: string | null
    hasLiveSnapshot: boolean
    validatorLabels: string[]
  }
}

export type AgentChatResponse = {
  content: string
  source: "llm" | "fallback"
}

export async function requestAgentReply(request: AgentChatRequest): Promise<AgentChatResponse> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`Agent API failed: ${response.status}`)
  return (await response.json()) as AgentChatResponse
}

export function toAgentChatContext(context: AgentContext): AgentChatRequest["context"] {
  return {
    account: context.account,
    chainId: context.chainId,
    liveBlock: context.liveBlock ? context.liveBlock.toString() : null,
    hasLiveSnapshot: Boolean(context.liveSnapshot),
    validatorLabels: context.validators.map((validator) => validator.label),
  }
}
