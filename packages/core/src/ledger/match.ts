import type { BankOperation } from '../mail/parse'

/** One mail's account of an operation, as stored with the movement it belongs to. */
export type MovementSource = { mailId: string; templateId: string; operation: BankOperation }

export type Candidate = { movementId: string; sources: MovementSource[] }

const same = (a: string | null, b: string | null) => a === null || b === null || a === b

/**
 * Finds the movement an operation belongs to, among movements with the same direction,
 * currency, amount and date. Two mails describe one operation when nothing they both state
 * disagrees and they share the counterparty's account or tax id. A movement never takes two
 * mails of the same template, so two equal transfers on one day stay two movements.
 * Candidates must come oldest first.
 */
export function matchMovement(
  incoming: { templateId: string; operation: BankOperation },
  candidates: readonly Candidate[],
): string | null {
  const op = incoming.operation
  for (const candidate of candidates) {
    if (candidate.sources.some((s) => s.templateId === incoming.templateId)) continue
    const agrees = candidate.sources.every(({ operation: o }) => {
      const sharesCounterparty =
        (op.counterparty.account !== null && op.counterparty.account === o.counterparty.account) ||
        (op.counterparty.taxId !== null && op.counterparty.taxId === o.counterparty.taxId)
      return (
        sharesCounterparty &&
        o.kind === op.kind &&
        o.currency === op.currency &&
        o.amount === op.amount &&
        o.date === op.date &&
        same(o.time, op.time) &&
        same(o.ownAccount, op.ownAccount) &&
        same(o.reference, op.reference) &&
        same(o.counterparty.account, op.counterparty.account) &&
        same(o.counterparty.taxId, op.counterparty.taxId)
      )
    })
    if (agrees) return candidate.movementId
  }
  return null
}

export type MergedOperation = BankOperation

/** A movement's facts: for each field, the first source that states it. Sources never conflict. */
export function mergeSources(sources: readonly MovementSource[]): MergedOperation {
  const first = sources[0]?.operation
  if (!first) throw new Error('a movement needs at least one source')
  const pick = <T>(read: (o: BankOperation) => T | null): T | null => {
    for (const s of sources) {
      const v = read(s.operation)
      if (v !== null) return v
    }
    return null
  }
  return {
    kind: first.kind,
    amount: first.amount,
    currency: first.currency,
    date: first.date,
    time: pick((o) => o.time),
    ownAccount: pick((o) => o.ownAccount),
    counterparty: {
      name: pick((o) => o.counterparty.name),
      account: pick((o) => o.counterparty.account),
      taxId: pick((o) => o.counterparty.taxId),
    },
    reference: pick((o) => o.reference),
    reason: pick((o) => o.reason),
  }
}
