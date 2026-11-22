import type { Sql } from './core/db'
import { sameValue } from './domain/facts'
import {
  type BatchFact,
  batchFacts,
  type FactRow,
  findLive,
  forgetFact,
  lockFacts,
  restoreFact,
  supersedeFact,
} from './facts'

/** What undoing one fact of the batch did. */
export type FactUndone =
  /** The batch stored it: it is forgotten now. */
  | { kind: 'fact_removed'; fact: FactRow }
  /** The batch changed its value: it has the old one again (`was` is the value undone). */
  | { kind: 'fact_reverted'; fact: FactRow; was: string }
  /** The batch forgot it: it is back. */
  | { kind: 'fact_restored'; fact: FactRow }

/** The facts a batch left behind and whether each still stands as the batch left it. Nothing is written yet. */
export interface FactPlan {
  /** The rows the batch stored (new or with a new value), with the live row that now holds that key. */
  made: { row: BatchFact; head: FactRow }[]
  /** The facts the batch ended, as they were before it: forgotten by it, or replaced by a row it forgot too. */
  forgotten: FactRow[]
  /** Facts that are no longer as the batch left them: the whole undo is refused. */
  moved: FactRow[]
}

/**
 * Reads what the batch did to facts and whether it can be undone. A fact is "as the batch left it" when, now:
 * - one the batch stored or changed is live with that same value (a later change would have moved it; a later change
 *   that was itself undone leaves the same value live again, which is what lets a second "deshacer" reach it);
 * - one the batch ended has no live fact in its place (a person who said it again since has changed it).
 * What the batch ended is a fact it forgot, and also the fact an update of its own replaced when the same message then
 * forgot the new value ("la visa es la del santander, olvidate de la visa"): that one is as good as forgotten by the
 * batch, so the undo brings it back. A row the batch stored and forgot with nothing before it is a net of nothing and is
 * left out. Takes the account's facts lock first, so no other message writes a fact between this read and the writes.
 */
export async function planFactUndo(tx: Sql, accountId: number, batch: number): Promise<FactPlan> {
  await lockFacts(tx, accountId)
  const plan: FactPlan = { made: [], forgotten: [], moved: [] }
  const ended: FactRow[] = []
  for (const row of await batchFacts(tx, accountId, batch)) {
    if (row.inbound === batch && row.forgottenBy === batch) {
      if (row.beforeId !== null && row.before !== null) {
        ended.push({ id: row.beforeId, kind: row.kind, key: row.key, value: row.before })
      }
    } else if (row.inbound === batch) {
      const [head] = await findLive(tx, accountId, { kind: row.kind, key: row.key })
      if (head && sameValue(head.value, row.value)) plan.made.push({ row, head })
      else plan.moved.push(row)
    } else if (row.forgottenBy === batch) ended.push(row)
  }
  const made = new Set(plan.made.map((m) => `${m.row.kind}:${m.row.key}`))
  for (const fact of ended) {
    // A fact the batch stored under the same key is about to be removed: it does not stand in the way.
    const [head] = await findLive(tx, accountId, { kind: fact.kind, key: fact.key })
    if (head && !made.has(`${fact.kind}:${fact.key}`)) plan.moved.push(fact)
    else plan.forgotten.push(fact)
  }
  return plan
}

/** Writes what the plan says, append-only: removal and revert first, then what comes back. */
export async function applyFactUndo(
  tx: Sql,
  o: { accountId: number; inboundId: number },
  plan: FactPlan,
): Promise<FactUndone[]> {
  const items: FactUndone[] = []
  for (const { row, head } of plan.made) {
    if (row.before === null) {
      if (!(await forgetFact(tx, head.id, o.inboundId))) throw new Error('fact is not live')
      items.push({ kind: 'fact_removed', fact: head })
    } else {
      const fact = await supersedeFact(tx, {
        accountId: o.accountId,
        inboundId: o.inboundId,
        kind: row.kind,
        key: row.key,
        value: row.before,
        old: head,
      })
      items.push({ kind: 'fact_reverted', fact, was: head.value })
    }
  }
  for (const fact of plan.forgotten) {
    items.push({ kind: 'fact_restored', fact: await restoreFact(tx, { ...o, fact }) })
  }
  return items
}
