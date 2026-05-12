import { CheckCircle2, Clock3, ExternalLink } from "lucide-react"
import type { ReactNode } from "react"
import { formatSafe, formatUsdFromSafe } from "../protocol"
import type { MessageBundle } from "./i18n"

export function FullPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel full-panel enter"><div className="panel-title"><h2>{title}</h2></div>{children}</section>
}

export function InfoCard({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return <div className="info-card"><span>{icon}</span><small>{title}</small><strong>{value}</strong></div>
}

export function Metric({ icon, label, value, unavailable, safePriceUsd }: { icon: ReactNode; label: string; value: bigint | null; unavailable: string; safePriceUsd: number | null }) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <span><small>{label}</small><strong>{value === null ? "--" : formatSafe(value)}</strong><em>{value === null ? unavailable : formatUsdFromSafe(value, safePriceUsd)}</em></span>
    </div>
  )
}

export function ActionButton(props: { active?: boolean; icon: ReactNode; title: string; subtitle: string; onClick: () => void }) {
  return <button className={`action-button ${props.active ? "active" : ""}`} onClick={props.onClick}><span>{props.icon}</span><strong>{props.title}</strong><small>{props.subtitle}</small></button>
}

export function Progress({ value, variant = "blue" }: { value: number; variant?: "blue" | "green" }) {
  return <span className="progress-track"><span className={`progress-fill ${variant}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>
}

export function StatusBadge({ status, t }: { status: string; t: MessageBundle }) {
  const label = status === "active" ? t.active : status === "inactive" ? t.inactive : status
  return <span className={`status-badge ${status}`}>{label}</span>
}

export function ChecklistRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className={`check-row ${ok ? "ok" : "needs-attention"}`}>{ok ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}<span>{label}</span><strong>{value}</strong></div>
}

export function KeyValue({ label, value, link }: { label: string; value: string; link?: string }) {
  return <div className="key-row"><span>{label}</span><strong>{value}</strong>{link && <a href={link} target="_blank" rel="noreferrer" aria-label={label}><ExternalLink size={14} /></a>}</div>
}
