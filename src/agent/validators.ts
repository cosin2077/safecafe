import { getAddress } from "viem"
import type { ValidatorInfo } from "../protocol"
import type { AgentValidatorRef } from "./types"

export type ResolvedAgentValidator = {
  validator: ValidatorInfo
  reason: string
}

export function resolveAgentValidator(ref: AgentValidatorRef, validators: ValidatorInfo[]): ResolvedAgentValidator {
  if (ref.type === "address") {
    const address = getAddress(ref.value)
    const validator = validators.find((item) => getAddress(item.address) === address)
    if (!validator) throw new Error(`Unknown validator: ${address}`)
    return { validator, reason: "Selected by address." }
  }

  if (ref.type === "label") {
    const normalized = ref.value.toLowerCase()
    const matches = validators.filter((item) => item.label.toLowerCase() === normalized)
    if (matches.length !== 1) throw new Error(`Unknown validator: ${ref.value}`)
    return { validator: matches[0], reason: "Selected by name." }
  }

  const active = validators.filter((item) => item.status === "active")
  if (!active.length) throw new Error("No active validators are available.")
  const [validator] = [...active].sort((a, b) => {
    if (b.participationRate !== a.participationRate) return b.participationRate - a.participationRate
    if (a.commission !== b.commission) return a.commission - b.commission
    if (a.totalStake !== b.totalStake) return a.totalStake > b.totalStake ? -1 : 1
    return a.label.localeCompare(b.label)
  })
  return {
    validator,
    reason: "Selected highest participation, then lowest commission, then highest total stake.",
  }
}
