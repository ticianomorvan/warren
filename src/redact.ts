import type { AuditEntry } from './agent/loop'

/**
 * What a message that holds something Warren must not keep leaves behind (agent slice F). A password, a card or CBU number or a
 * DNI is not stored as a fact, and it is not kept anywhere else either: the message's stored text, the audit of the model's calls
 * and what ran (`turn.calls`, scrubbed by `commit`) are wiped at the commit point, and the conversation window the model reads in
 * the next 30 minutes shows the placeholder. `wa_message` keeps no raw payload, so the text is the only place it could be.
 */
export const REDACTED_BODY = '[dato sensible, no guardado]'
const REDACTED = '[redacted]'

/** The audit with every input and every reason wiped. */
export const scrubAudit = (audit: AuditEntry[]): AuditEntry[] =>
  audit.map(({ detail: _, ...entry }) => ({ ...entry, input: REDACTED }))
