import { BotMessageSquare } from "lucide-react"

export function AgentLogo(props: { size?: "md" | "lg" }) {
  return (
    <span className={`agent-logo ${props.size === "lg" ? "large" : ""}`} aria-hidden="true">
      <BotMessageSquare className="agent-logo-icon" strokeWidth={2.2} />
    </span>
  )
}
