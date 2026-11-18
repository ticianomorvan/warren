import type { BankOperation } from '../mail/parse'
import { isNews } from './notice-policy'

export { eventId } from './ids'
export { type Candidate, type MovementSource, matchMovement, mergeSources } from './match'
export { isNews, NOTICE_MAX_AGE_HOURS } from './notice-policy'

export type AccountKind = 'asset' | 'liability'

/** One of the user's accounts. "Own" is decided only by the identifiers listed here. */
export type AccountSeed = {
  /** Stable slug, e.g. "asset:bbva:ars". */
  id: string
  kind: AccountKind
  name: string
  currency: string
  institution: string
  identifiers: { scheme: 'cbu' | 'bank-label' | 'card-last-four'; value: string }[]
}

export type RecordOutcome = {
  movementId: string
  /** 'created' a new movement, 'linked' to an existing one, or already recorded. */
  outcome: 'created' | 'linked' | 'duplicate'
  /** 'own_transfer' when the counterparty is one of the user's accounts. */
  type: 'own_transfer' | 'unclassified' | 'card_purchase'
}

export type ParsedMail = { mailId: string; templateId: string; operation: BankOperation }

/** A parsed mail the ledger has not recorded yet, with when it reached the receiving provider. */
export type PendingMail = ParsedMail & { receivedAt: Date }

export type RecordOptions = {
  /**
   * Whether a movement this call creates owes its user a notice. Required: every caller decides.
   * A rebuild or an import passes false: those movements are not news, and a notice is not
   * retracted once sent.
   */
  notify: boolean
}

/** One user's ledger: every call acts for the user it was created for. */
export interface Ledger {
  /** Records what a parsed mail says happened. One real operation becomes one movement. */
  recordMailOperation(mail: ParsedMail, options: RecordOptions): Promise<RecordOutcome>
  /** Parsed mails not yet reflected in the ledger, oldest first. */
  pendingMailOperations(): Promise<PendingMail[]>
}

/**
 * Records every parsed mail the ledger does not have yet. Safe to run at any time. This runs when
 * templates change and mail is reparsed, so most of what it records is old: a movement owes a
 * notice only if its mail is still news (`isNews`), the same rule as replaying unrouted mail.
 */
export async function recordPending(
  ledger: Ledger,
  now: () => Date = () => new Date(),
): Promise<(RecordOutcome & { mailId: string })[]> {
  const out = []
  for (const { receivedAt, ...mail } of await ledger.pendingMailOperations()) {
    const recorded = await ledger.recordMailOperation(mail, { notify: isNews(receivedAt, now()) })
    out.push({ mailId: mail.mailId, ...recorded })
  }
  return out
}
