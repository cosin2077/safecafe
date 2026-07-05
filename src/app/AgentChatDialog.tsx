import { AlertTriangle, CheckCircle2, Download, Send, Wallet, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import {
  type AgentContext,
  type AgentIntent,
  type AgentPlan,
  type AgentRisk,
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  parseAgentInstruction,
  requestAgentReply,
  toAgentChatContext,
} from "../agent"
import { compactAddress, type TxPlan } from "../protocol"
import { translateTxLabel, translateTxWarning } from "./formatters"
import type { MessageBundle } from "./i18n"

type AgentChatMessage = {
  id: string
  role: "assistant" | "user"
  content: string
}

export type AgentChatDialogProps = {
  t: MessageBundle
  isOpen: boolean
  anchor: { x: number; y: number } | null
  context: AgentContext
  isSubmitting: boolean
  onApplyPlan: (plan: TxPlan) => void
  onClose: () => void
  onConnectWallet: () => Promise<void>
  onExportPlan: (plan: TxPlan) => void
  onSimulatePlan: (plan: TxPlan) => Promise<TxPlan>
  onSubmitPlan: (plan: TxPlan) => Promise<void>
}

export function AgentChatDialog(props: AgentChatDialogProps) {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [draft, setDraft] = useState<AgentPlan | null>(null)
  const [executablePlan, setExecutablePlan] = useState<TxPlan | null>(null)
  const [isDrafting, setIsDrafting] = useState(false)
  const [warningsAccepted, setWarningsAccepted] = useState(false)
  const [draftKey, setDraftKey] = useState("")
  const [pendingIntentText, setPendingIntentText] = useState("")
  const dialogRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const currentContextKey = `${props.context.account ?? ""}:${props.context.chainId ?? ""}:${props.context.liveBlock ?? ""}`
  const isStale = Boolean(draft && draftKey && draftKey !== currentContextKey)
  const blocked = draft?.risks.some((risk) => risk.severity === "blocked") ?? false
  const warnings = useMemo(() => collectWarnings(draft, executablePlan), [draft, executablePlan])
  const canUsePlan = Boolean(executablePlan && !blocked && !isStale && (warnings.length === 0 || warningsAccepted))

  useEffect(() => {
    if (!props.isOpen) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
      if (event.key === "Tab") trapFocus(event, dialogRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [props.isOpen, props.onClose])

  useEffect(() => {
    if (!props.isOpen) return
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [props.isOpen])

  useEffect(() => {
    if (!props.isOpen) return
    const scrollToLatest = () => {
      messageEndRef.current?.scrollIntoView({ block: "end" })
      const list = messageListRef.current
      if (list) list.scrollTop = list.scrollHeight
    }
    const frame = window.requestAnimationFrame(() => {
      scrollToLatest()
    })
    const timer = window.setTimeout(scrollToLatest, 80)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  })

  async function send(text = input) {
    const trimmed = text.trim()
    if (!trimmed || isDrafting) return
    setInput("")
    setWarningsAccepted(false)
    setDraft(null)
    setExecutablePlan(null)
    setMessages((current) => [...current, createMessage("user", trimmed)])

    const candidate = pendingIntentText ? `${pendingIntentText} ${trimmed}` : trimmed
    const parse = parseAgentInstruction(candidate, props.context.validators)
    const history = messages.map(({ role, content }) => ({ role, content }))

    if (parse.status === "needs-clarification") {
      setPendingIntentText(candidate)
      setMessages((current) => [...current, createMessage("assistant", parse.question)])
      void appendAgentReply(trimmed, history)
      return
    }
    setPendingIntentText("")
    if (parse.status === "blocked") {
      setMessages((current) => [...current, createMessage("assistant", riskText(parse.risks, props.t))])
      return
    }
    if (!props.context.account || !props.context.liveSnapshot) {
      setMessages((current) => [...current, createMessage("assistant", props.t.agentWalletRequired)])
      void appendAgentReply(trimmed, history)
      return
    }

    setIsDrafting(true)
    try {
      const nextDraft = compileAgentPlan(candidate, parse.intent, props.context)
      const flattened = flattenExecutableTxPlan(nextDraft) ?? flattenCurrentExecutableTxPlan(nextDraft)
      const simulated = flattened ? await props.onSimulatePlan(flattened) : null
      setDraft(nextDraft)
      setExecutablePlan(simulated)
      setDraftKey(currentContextKey)
      setMessages((current) => [
        ...current,
        createMessage("assistant", simulated ? props.t.agentPlanReady : props.t.agentPlanDrafted),
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        createMessage("assistant", error instanceof Error ? error.message : props.t.buildPlanFailed),
      ])
    } finally {
      setIsDrafting(false)
    }
  }

  async function appendAgentReply(message: string, history: Array<{ role: "assistant" | "user"; content: string }>) {
    try {
      const reply = await requestAgentReply({
        message,
        messages: history,
        context: toAgentChatContext(props.context),
      })
      if (!reply.content.trim()) return
      setMessages((current) => [...current, createMessage("assistant", reply.content)])
    } catch {
      return
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  if (!props.isOpen) return null

  return (
    <section
      ref={dialogRef}
      className="agent-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={props.t.agentTitle}
      style={props.anchor ? dialogPosition() : undefined}
    >
      <div className="agent-dialog-header">
        <div>
          <strong>{props.t.agentTitle}</strong>
          <span>{props.context.account ? compactAddress(props.context.account) : props.t.notConnected}</span>
        </div>
        <button type="button" className="agent-icon-button" onClick={props.onClose} aria-label={props.t.agentClose}>
          <X size={18} />
        </button>
      </div>

      <div className="agent-message-list" ref={messageListRef}>
        <article className="agent-message assistant">{props.t.agentGreeting}</article>
        <div className="agent-prompt-chip-row">
          {[
            props.t.agentPromptClaimRewards,
            props.t.agentPromptStake,
            props.t.agentPromptRestake,
            props.t.agentPromptRebalance,
          ].map((prompt) => (
            <button type="button" key={prompt} onClick={() => void send(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
        {messages.map((message) => (
          <article className={`agent-message ${message.role}`} key={message.id}>
            {message.content}
          </article>
        ))}
        {!props.context.account && (
          <button type="button" className="agent-connect-button" onClick={() => void props.onConnectWallet()}>
            <Wallet size={16} />
            {props.t.connectWallet}
          </button>
        )}
        {draft && (
          <AgentPlanCard
            t={props.t}
            draft={draft}
            executablePlan={executablePlan}
            isStale={isStale}
            warnings={warnings}
            warningsAccepted={warningsAccepted}
            canUsePlan={canUsePlan}
            isSubmitting={props.isSubmitting}
            onAcceptWarnings={setWarningsAccepted}
            onApply={() => executablePlan && props.onApplyPlan(executablePlan)}
            onExport={() => executablePlan && props.onExportPlan(executablePlan)}
            onSubmit={() => executablePlan && void props.onSubmitPlan(executablePlan)}
          />
        )}
        <div className="agent-message-end" ref={messageEndRef} aria-hidden="true" />
      </div>

      <div className="agent-dialog-footer">
        <label className="agent-composer">
          <span>{props.t.agentPrompt}</span>
          <textarea
            ref={composerRef}
            rows={2}
            value={input}
            placeholder={props.t.agentPlaceholder}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
        </label>
        <button
          type="button"
          className="agent-send-button"
          disabled={isDrafting || !input.trim()}
          onClick={() => void send()}
        >
          <Send size={16} />
          {isDrafting ? props.t.reading : props.t.agentSend}
        </button>
      </div>
    </section>
  )
}

function dialogPosition() {
  const width = 420
  const height = 620
  const left = Math.max(292, window.innerWidth - width - 24)
  const top = Math.max(16, window.innerHeight - height - 24)
  return { left, top, right: "auto", bottom: "auto" }
}

function trapFocus(event: globalThis.KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function AgentPlanCard(props: {
  t: MessageBundle
  draft: AgentPlan
  executablePlan: TxPlan | null
  isStale: boolean
  warnings: string[]
  warningsAccepted: boolean
  canUsePlan: boolean
  isSubmitting: boolean
  onAcceptWarnings: (value: boolean) => void
  onApply: () => void
  onExport: () => void
  onSubmit: () => void
}) {
  const intentLabel = describeIntent(props.draft.intent)
  return (
    <article className={`agent-plan-card ${props.isStale ? "stale" : ""}`}>
      <div className="agent-plan-title">
        <CheckCircle2 size={18} />
        <span>
          <strong>{props.t.agentParsedIntent}</strong>
          <small>{intentLabel}</small>
        </span>
      </div>
      {props.isStale && <p className="agent-risk blocked">{props.t.agentStalePlan}</p>}
      {props.draft.risks.length > 0 && (
        <div className="agent-risk-list">
          <strong>{props.t.agentRisks}</strong>
          {props.draft.risks.map((risk) => (
            <p className={`agent-risk ${risk.severity}`} key={`${risk.code}-${risk.message}`}>
              {translateAgentRisk(risk, props.t)}
            </p>
          ))}
        </div>
      )}
      <div className="agent-phase-list">
        <strong>{props.t.agentPlanPhases}</strong>
        {props.draft.phases.map((phase) => (
          <div className="agent-phase" key={phase.id}>
            <span>{phase.title}</span>
            <small>{phase.executableNow ? props.t.ready : props.t.agentDelayedPhase}</small>
          </div>
        ))}
      </div>
      {props.executablePlan && (
        <div className="agent-tx-list">
          <strong>{props.t.transactionSteps}</strong>
          {props.executablePlan.txs.map((tx) => (
            <span key={`${tx.to}-${tx.data}`}>{translateTxLabel(tx.label, props.t)}</span>
          ))}
        </div>
      )}
      {props.warnings.length > 0 && (
        <label className="agent-warning-ack">
          <input
            type="checkbox"
            checked={props.warningsAccepted}
            onChange={(event) => props.onAcceptWarnings(event.target.checked)}
          />
          <span>{props.t.agentAcknowledgeWarnings}</span>
        </label>
      )}
      <p className="agent-review-reminder">
        <AlertTriangle size={15} />
        {props.t.agentReviewReminder}
      </p>
      <div className="agent-plan-actions">
        <button type="button" className="soft-button" disabled={!props.canUsePlan} onClick={props.onApply}>
          {props.t.applyAgentPlan}
        </button>
        <button type="button" className="soft-button" disabled={!props.canUsePlan} onClick={props.onExport}>
          <Download size={15} />
          {props.t.exportSafePayload}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!props.canUsePlan || props.isSubmitting}
          onClick={props.onSubmit}
        >
          {props.isSubmitting ? props.t.submitting : props.t.submitTransactions}
        </button>
      </div>
    </article>
  )
}

function describeIntent(intent: AgentIntent) {
  if (intent.kind === "claim-rewards") return "claim rewards"
  if (intent.kind === "claim-withdrawal") return "claim withdrawal"
  if (intent.kind === "rebalance") return "rebalance stake"
  if (intent.kind === "restake-rewards") return "restake rewards"
  return intent.kind
}

function createMessage(role: AgentChatMessage["role"], content: string): AgentChatMessage {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, role, content }
}

function collectWarnings(draft: AgentPlan | null, plan: TxPlan | null) {
  if (!draft) return []
  return [
    ...draft.risks.filter((risk) => risk.severity === "warning").map((risk) => risk.message),
    ...(plan?.warnings ?? []),
  ]
}

function riskText(risks: AgentRisk[], t: MessageBundle) {
  if (!risks.length) return t.agentUnsupported
  return risks.map((risk) => translateAgentRisk(risk, t)).join("\n")
}

function translateAgentRisk(risk: AgentRisk, t: MessageBundle) {
  if (risk.code === "unsupported-operation") return t.agentUnsupported
  if (risk.code === "validator-selection") {
    if (risk.message === "Selected by address.") return t.agentValidatorSelectedByAddress
    if (risk.message === "Selected by name.") return t.agentValidatorSelectedByName
    return t.agentValidatorSelectedBest
  }
  if (risk.code === "wallet-required") return t.agentWalletRequired
  if (risk.code === "live-data-required") return t.agentLiveDataRequired
  if (risk.code === "wrong-chain") return t.wrongNetwork
  if (risk.code === "validators-required") return t.agentValidatorsRequired
  if (risk.code === "inactive-validator") return t.inactiveValidator
  if (risk.code === "insufficient-safe-balance") return t.insufficientSafeBalance
  if (risk.code === "insufficient-validator-stake") return t.insufficientValidatorStake
  if (risk.code === "no-claimable-withdrawal") return t.noClaimableWithdrawal
  if (risk.code === "reward-proof-required") return t.agentRewardProofRequired
  if (risk.code === "merkle-root-mismatch") return t.merkleMismatch
  if (risk.code === "no-claimable-rewards") return t.noProof
  if (risk.code === "delayed-phase") return t.agentDelayedPhaseRisk
  if (risk.code === "compile-failed") return t.buildPlanFailed
  return translateTxWarning(risk.message, t)
}
