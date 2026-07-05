type AgentApiEnv = {
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
}

type AgentApiRequest = {
  message?: unknown
  messages?: unknown
  context?: unknown
}

export async function handleAgentApiRequest(request: Request, env: AgentApiEnv): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  const base = env.SAFECAFE_LLM_API_BASE
  const model = env.SAFECAFE_LLM_API_MODEL
  const apiKey = env.SAFECAFE_LLM_API_KEY
  if (!base || !model || !apiKey) {
    return json(
      {
        content:
          "Agent LLM is not configured. I can still draft supported staking plans locally after wallet data is loaded.",
        source: "fallback",
      },
      200,
    )
  }

  const body = (await request.json().catch(() => ({}))) as AgentApiRequest
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : ""
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((item): item is { role: string; content: string } => isChatMessage(item))
        .slice(-8)
        .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }))
    : []
  const context = summarizeContext(body.context)

  const upstream = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are Safecafe Staking Agent. Help the user express SAFE staking intent. Never claim you can sign or submit transactions. Never generate calldata. Keep answers concise. Supported operations: stake, unstake, claim withdrawal, claim rewards, restake rewards, rebalance after withdrawal delay. Tell users every on-chain action requires wallet confirmation.",
        },
        {
          role: "system",
          content: `Current app context: ${context}`,
        },
        ...messages,
        { role: "user", content: message },
      ],
    }),
  })

  if (!upstream.ok) {
    return json(
      {
        content: "The Agent service is unavailable. Local staking plan checks are still available.",
        source: "fallback",
      },
      200,
    )
  }

  const data = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = data.choices?.[0]?.message?.content
  const sanitizedContent = sanitizeAgentContent(content)
  return json(
    {
      content: sanitizedContent,
      source: "llm",
    },
    200,
  )
}

function isChatMessage(value: unknown): value is { role: "assistant" | "user"; content: string } {
  if (typeof value !== "object" || value === null) return false
  const item = value as { role?: unknown; content?: unknown }
  return (item.role === "assistant" || item.role === "user") && typeof item.content === "string"
}

function summarizeContext(value: unknown) {
  if (typeof value !== "object" || value === null) return "No context."
  const context = value as Record<string, unknown>
  return JSON.stringify({
    accountConnected: typeof context.account === "string",
    chainId: context.chainId ?? null,
    liveBlock: context.liveBlock ?? null,
    hasLiveSnapshot: Boolean(context.hasLiveSnapshot),
    validatorLabels: Array.isArray(context.validatorLabels) ? context.validatorLabels.slice(0, 20) : [],
  })
}

export function sanitizeAgentContent(content: unknown) {
  if (typeof content !== "string" || !content.trim()) return "I can help draft a staking plan."
  const trimmed = content.trim()
  if (unsafeOutputPattern.test(trimmed)) {
    return "I can only help draft a reviewable staking plan. Every on-chain action must be confirmed in your wallet."
  }
  return trimmed
}

const unsafeOutputPattern =
  /\b(i\s+can\s+sign|i\s+will\s+sign|i'?ll\s+sign|sign\s+for\s+you|sign\s+on\s+your\s+behalf|i\s+can\s+submit|i\s+will\s+submit|i'?ll\s+submit|submit\s+for\s+you|submit\s+the\s+transaction\s+for\s+you|send\s+the\s+transaction\s+for\s+you|execute\s+automatically|automatically\s+execute|auto-?sign|call\s+data|calldata|raw\s+transaction|transaction\s+data|0x[a-f0-9]{32,})\b|我可以代签|我会代签|替你签名|帮你签名|我可以提交|我会提交|替你提交|帮你提交|帮我提交|替我提交|代我提交|代提交|自动执行|自动提交|代你提交|交易数据|调用数据/i

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}
