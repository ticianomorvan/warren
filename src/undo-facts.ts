import { sameValue } from './agent/memory'
import type { Sql } from './db'
import {
  type BatchFact,
  batchFacts,
  type FactRow,
  forgetFact,
  liveFactByKey,
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
  /** The rows the batch forgot. */
  forgotten: BatchFact[]
  /** Facts that are no longer as the batch left them: the whole undo is refused. */
  moved: FactRow[]
}

/**
 * Reads what the batch did to facts and whether it can be undone. A fact is "as the batch left it" when, now:
 * - one the batch stored or changed is live with that same value (a later change would have moved it; a later change
 *   that was itself undone leaves the same value live again, which is what lets a second "deshacer" reach it);
 * - one the batch forgot has no live fact in its place (a person who said it again since has changed it).
 * A row the batch stored and forgot is a net of nothing and is left out. Takes the account's facts lock first,
 * so no other message writes a fact between this read and the writes.
 */
export async function planFactUndo(tx: Sql, accountId: number, batch: number): Promise<FactPlan> {
  await lockFacts(tx, accountId)
  const rows = (await batchFacts(tx, accountId, batch)).filter(
    (r) => !(r.inbound === batch && r.forgottenBy === batch),
  )
  const plan: FactPlan = { made: [], forgotten: [], moved: [] }
  for (const row of rows) {
    if (row.inbound !== batch) continue
    const head = await liveFactByKey(tx, accountId, row.kind, row.key)
    if (head && sameValue(head.value, row.value)) plan.made.push({ row, head })
    else plan.moved.push(row)
  }
  const made = new Set(plan.made.map((m) => `${m.row.kind}:${m.row.key}`))
  for (const row of rows) {
    if (row.forgottenBy !== batch || row.inbound === batch) continue
    // A fact the batch stored under the same key is about to be removed: it does not stand in the way.
    const head = await liveFactByKey(tx, accountId, row.kind, row.key)
    if (head && !made.has(`${row.kind}:${row.key}`)) plan.moved.push(row)
    else plan.forgotten.push(row)
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
      await forgetFact(tx, head.id, o.inboundId)
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
  for (const row of plan.forgotten) {
    items.push({ kind: 'fact_restored', fact: await restoreFact(tx, { ...o, fact: row }) })
  }
  return items
}
