type SessionLabelSource = {
  id?: string | null
  kind?: string | null
  label?: string | null
  alias?: string | null
  displayName?: string | null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function trimmed(value?: string | null) {
  const next = value?.trim()
  return next && next.length > 0 ? next : undefined
}

function explicitLabel(value: string | undefined, id: string | undefined) {
  if (!value || value === id || UUID_PATTERN.test(value)) return undefined
  return value
}

export function shortSessionId(value?: string | null) {
  return trimmed(value)?.slice(0, 8) ?? "-"
}

export function friendlySessionLabel(session?: SessionLabelSource | null, fallbackId?: string | null) {
  const id = trimmed(session?.id) ?? trimmed(fallbackId)
  const explicit =
    [session?.displayName, session?.alias, session?.label]
      .map(trimmed)
      .map((value) => explicitLabel(value, id))
      .find(Boolean)

  if (explicit) return explicit
  if (session?.kind === "main") return "Main session"
  if (session?.kind === "branch") return id ? `Branch session ${shortSessionId(id)}` : "Branch session"
  return id ? `Session ${shortSessionId(id)}` : "Session"
}

export function sessionPickerLabel(session: SessionLabelSource) {
  const kind = trimmed(session.kind) ?? "session"
  return `${friendlySessionLabel(session)} · ${kind} · ${shortSessionId(session.id)}`
}

export function sessionReferenceLabel(label?: string | null, sessionId?: string | null) {
  const explicit = explicitLabel(trimmed(label), trimmed(sessionId))
  const id = trimmed(sessionId)
  if (explicit) return explicit
  return id ? `Session ${shortSessionId(id)}` : "-"
}
