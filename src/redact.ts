import type { AuditEntry } from './agent/loop'
import { REPLY_FACT_SECRET } from './render'

/**
 * What a message that holds something Warren must not keep leaves behind (agent slice F). A password, a card or CBU number or a
 * DNI is not stored as a fact, and it is not kept anywhere else either: the message's stored text, the raw webhook
 * object, the audit of the model's calls and what ran are wiped at the commit point, and the conversation window the model
 * reads in the next 30 minutes shows the placeholder. (Until that commit the webhook's own row holds the text: it is how the
 * agent reads it.)
 */
export const REDACTED_BODY = '[dato sensible, no guardado]'
const REDACTED = '[redacted]'

/** The notice code answers a refused secret with: when it is in a message's actions, the message held a secret. */
export const isSecretNotice = (a: { tool: string; input: unknown }) =>
  a.tool === 'notice' && (a.input as { text?: string }).text === REPLY_FACT_SECRET

/** The tool calls with their inputs wiped: what ran stays visible, what it was sent does not. */
export const scrubCalls = <T extends { tool: string }>(calls: T[] | unknown) =>
  Array.isArray(calls) ? calls.map((c: T) => ({ tool: c.tool, input: REDACTED })) : calls

/** The audit with every input and every reason wiped. */
export const scrubAudit = (audit: AuditEntry[]): AuditEntry[] =>
  audit.map(({ detail: _, ...entry }) => ({ ...entry, input: REDACTED }))
