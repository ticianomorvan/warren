import type { BankOperation, TransferOperation } from '../mail/parse'

/** One mail's account of an operation, as stored with the movement it belongs to. */
export type MovementSource = { mailId: string; templateId: string; operation: BankOperation }

/**
 * The accounts a movement or a mail resolves to, by the ledger's account ids. `own` is the
 * account the money moved on, `counter` the one it went to or came from.
 */
export type Accounts = { own: string | null; counter: string | null }

export type Candidate = {
  movementId: string
  sources: MovementSource[]
  /** The movement's resolved accounts. Without them the cross-bank rule does not apply. */
  accounts?: Accounts | undefined
}

const same = (a: string | null, b: string | null) => a === null || b === null || a === b

const namesNoCounterparty = (o: TransferOperation) =>
  o.counterparty.account === null && o.counterparty.taxId === null

const isTransfer = (o: BankOperation): o is TransferOperation => o.kind !== 'card_purchase'

/**
 * Finds the movement an operation belongs to, among movements with the same currency, amount
 * and date. Two rules, tried in this order. A movement never takes two mails of the same
 * template, so two equal transfers on one day stay two movements. Candidates must come oldest
 * first.
 *
 * 1. Same direction: two mails describe one operation when nothing they both state disagrees and
 *    they share the counterparty's account or tax id.
 * 2. The other bank's leg: of two mails of the opposite direction, one names no counterparty (a
 *    wallet's mail names none), and the accounts mirror: the incoming mail's own account is the
 *    movement's counter account, or its counter account is the movement's own. The two banks'
 *    clocks differ, so times are not compared. Two such movements make the mail ambiguous, and
 *    it joins neither.
 */
export function matchMovement(
  incoming: { templateId: string; operation: BankOperation; accounts?: Accounts | undefined },
  candidates: readonly Candidate[],
): string | null {
  const op = incoming.operation
  // A purchase is one mail's account of one movement; it never joins a transfer or another purchase.
  if (!isTransfer(op)) return null
  const open = candidates.filter(
    (c) => !c.sources.some((s) => s.templateId === incoming.templateId),
  )
  for (const candidate of open) {
    // A leg from the other bank (the other direction) says nothing about this rule.
    const sameSide = candidate.sources.flatMap((s) =>
      isTransfer(s.operation) && s.operation.kind === op.kind ? [s.operation] : [],
    )
    const agrees = sameSide.every((o) => {
      const sharesCounterparty =
        (op.counterparty.account !== null && op.counterparty.account === o.counterparty.account) ||
        (op.counterparty.taxId !== null && op.counterparty.taxId === o.counterparty.taxId)
      return (
        sharesCounterparty &&
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
    if (sameSide.length > 0 && agrees) return candidate.movementId
  }
  const mine = incoming.accounts
  if (!mine) return null
  const legs = open.filter((c) => {
    const theirs = c.accounts
    if (!theirs) return false
    const ops = c.sources.map((s) => s.operation)
    const mirrors =
      (mine.own !== null && mine.own === theirs.counter) ||
      (mine.counter !== null && mine.counter === theirs.own)
    return (
      mirrors &&
      (namesNoCounterparty(op) || ops.every((o) => isTransfer(o) && namesNoCounterparty(o))) &&
      same(mine.own, theirs.counter) &&
      same(mine.counter, theirs.own) &&
      ops.every(
        (o) =>
          isTransfer(o) &&
          o.kind !== op.kind &&
          o.currency === op.currency &&
          o.amount === op.amount &&
          o.date === op.date,
      )
    )
  })
  return legs.length === 1 ? (legs[0]?.movementId ?? null) : null
}

/**
 * A movement's facts: for each field, the first source that states it, among the sources that
 * carry the movement. Those are the sources that name a counterparty account (a bank's), or all
 * of them when none does; a source of the other direction is the other bank's view of the same
 * money, and adds nothing but its place in the movement. A purchase has exactly one source, so
 * it is returned as it is.
 */
export function mergeSources(sources: readonly MovementSource[]): BankOperation {
  const first = sources[0]?.operation
  if (!first) throw new Error('a movement needs at least one source')
  if (first.kind === 'card_purchase') return first
  const all = sources.flatMap((s) => (isTransfer(s.operation) ? [s.operation] : []))
  const lead = all.find((o) => o.counterparty.account !== null) ?? first
  const transfers = all.filter((o) => o.kind === lead.kind)
  const pick = <T>(read: (o: TransferOperation) => T | null): T | null => {
    for (const o of transfers) {
      const v = read(o)
      if (v !== null) return v
    }
    return null
  }
  return {
    kind: lead.kind,
    amount: lead.amount,
    currency: lead.currency,
    date: lead.date,
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
