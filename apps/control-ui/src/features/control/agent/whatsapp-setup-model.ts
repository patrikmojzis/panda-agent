export type WhatsAppAttemptState =
  | "starting"
  | "awaiting_confirmation"
  | "linked"
  | "failed"
  | "cancelled"
  | "expired"

export type WhatsAppSetupStage =
  | "create"
  | "loading"
  | "link"
  | "linking"
  | "connected"
  | "disabled"
  | "error"
  | "reset_required"

export function isActiveWhatsAppAttempt(
  state: WhatsAppAttemptState | undefined
) {
  return state === "starting" || state === "awaiting_confirmation"
}

export function resolveWhatsAppSetupStage(input: {
  hasAccount: boolean
  account?: {
    authStored: boolean
    enabled: boolean
    linked: boolean
    providerAccountId?: string
    status?: string
  }
  attemptState?: WhatsAppAttemptState
}): WhatsAppSetupStage {
  if (isActiveWhatsAppAttempt(input.attemptState)) return "linking"
  if (!input.hasAccount) return "create"
  if (!input.account) return "loading"
  if (input.account.status === "error") return "error"
  if (input.account.linked && input.account.enabled) return "connected"
  if (input.account.linked) return "disabled"
  if (input.account.authStored || input.account.providerAccountId)
    return "reset_required"
  return "link"
}

export function isExactWhatsAppActorJid(value: string) {
  return /^\d{8,20}@(s\.whatsapp\.net|lid)$/i.test(value.trim())
}

export function resolveWhatsAppManagementActions(
  account:
    | {
        enabled: boolean
        linked: boolean
        status?: string
      }
    | undefined
) {
  return {
    canDisable: Boolean(account?.enabled),
    canEnable: Boolean(
      account?.linked && !account.enabled && account.status !== "error"
    ),
    canReset: account?.status === "disabled" || account?.status === "error",
  }
}

export function displayWhatsAppState(
  value: string | undefined,
  fallback = "Unknown"
) {
  if (!value) return fallback
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase())
}
