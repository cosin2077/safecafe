export function isAgentAuthRequiredValue(value?: string) {
  return value?.trim().toLowerCase() !== "false"
}

export function resolveAgentAuthRequired(value?: string) {
  return isAgentAuthRequiredValue(value)
}
