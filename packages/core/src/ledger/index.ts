import type { BankOperation } from '../mail/parse'

export { eventId } from './ids'
export { type Candidate, type MovementSource, matchMovement, mergeSources } from './match'

export type AccountKind = 'asset' | 'liability'

/** One of the owner's accounts. "Own" is decided only by the identifiers listed here. */
export type AccountSeed = {
  /** Stable slug, e.g. "asset:bbva:ars". */
  id: string
  kind: AccountKind
  name: string
  currency: string
  institution: string
  identifiers: { scheme: 'cbu' | 'bank-label'; value: string }[]
}

export type RecordOutcome = {
  movementId: string
  /** 'created' a new movement, 'linked' to an existing one, or already recorded. */
  outcome: 'created' | 'linked' | 'duplicate'
  /** 'own_transfer' when the counterparty is one of the owner's accounts. */
  type: 'own_transfer' | 'unclassified'
}

export type ParsedMail = { mailSha256: string; templateId: string; operation: BankOperation }

export interface Ledger {
  /** Records what a parsed mail says happened. One real operation becomes one movement. */
  recordMailOperation(mail: ParsedMail): Promise<RecordOutcome>
  /** Parsed mails not yet reflected in the ledger, oldest first. */
  pendingMailOperations(): Promise<ParsedMail[]>
}

/** Records every parsed mail the ledger does not have yet. Safe to run at any time. */
export async function recordPending(
  ledger: Ledger,
): Promise<(RecordOutcome & { mailSha256: string })[]> {
  const out = []
  for (const mail of await ledger.pendingMailOperations()) {
    out.push({ mailSha256: mail.mailSha256, ...(await ledger.recordMailOperation(mail)) })
  }
  return out
}
