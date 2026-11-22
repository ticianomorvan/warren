import type { Sql } from './db'
import {
  type BatchRow,
  batchRows,
  copyVersion,
  followForward,
  lastBatch,
  lockLive,
  lockRows,
  type MovementRow,
  markUndone,
  rowsByIds,
  settledBatches,
  softDelete,
} from './ledger'

/** How long a batch can be undone: past it, the person is told and nothing is touched. */
export const UNDO_WINDOW_HOURS = 24

/** What undoing one movement of the batch did. */
export type Undone =
  /** The batch logged it: it is deleted now. */
  | { kind: 'logged'; movement: MovementRow }
  /** The batch corrected it: it stands as it was before (`to`), no longer as the correction left it (`from`). */
  | { kind: 'corrected'; from: MovementRow; to: MovementRow }
  /** The batch deleted it: it is back. */
  | { kind: 'deleted'; movement: MovementRow }

export type UndoOutcome =
  | { kind: 'undone'; batch: number; items: Undone[] }
  /** The sender has no batch left to undo. */
  | { kind: 'nothing' }
  /** Their last batch is older than the window. */
  | { kind: 'expired' }
  /** A movement of the batch is no longer as the batch left it: nothing was changed. `moved` are those movements. */
  | { kind: 'stale'; moved: MovementRow[] }

/** The movements a batch left behind, by what it did to them. */
interface Effects {
  logged: BatchRow[]
  /** The correction's new row, and the row it replaced. */
  corrected: { now: BatchRow; before: number }[]
  deleted: BatchRow[]
}

function effectsOf(rows: BatchRow[], batch: number): Effects {
  const out: Effects = { logged: [], corrected: [], deleted: [] }
  for (const row of rows) {
    if (row.deletedBy === batch) out.deleted.push(row)
    else if (row.inbound === batch && row.predecessor === null) out.logged.push(row)
    else if (row.inbound === batch && row.predecessor !== null) {
      out.corrected.push({ now: row, before: row.predecessor })
    }
  }
  return out
}

/**
 * Undoes the sender's last write batch: every change one earlier message made, as one step. Runs inside the
 * commit transaction of the message that asks (`inboundId`), and never edits history:
 *   - what the batch logged is soft-deleted (`deleted_by` is the undo message);
 *   - what it corrected is superseded by a new row with the values from before the correction;
 *   - what it deleted comes back as a new row (`restores` names the deleted one).
 * The undo message is marked `undoes` that batch, which is also what makes the next "deshacer" reach the batch
 * before it. All or nothing: if any movement of the batch is no longer as the batch left it (someone corrected
 * or deleted it since), nothing is changed. A movement is "as the batch left it" when what came after it was
 * only the work of batches that were undone (their undo made new rows, so the movement is now the head of a
 * chain) and it is live. Every row involved is locked first, so a message that changes one at the same moment
 * either goes first (the undo then sees it and refuses) or waits (and then finds the movement gone).
 */
export async function undoLast(
  tx: Sql,
  o: { accountId: number; inboundId: number },
): Promise<UndoOutcome> {
  // Two undos of one sender cannot interleave: the second sees the first's mark and reaches the batch before.
  await tx`SELECT pg_advisory_xact_lock(7203002, ${o.accountId}::int)`
  const last = await lastBatch(tx, o)
  if (!last) return { kind: 'nothing' }
  if (last.ageSecs > UNDO_WINDOW_HOURS * 3600) return { kind: 'expired' }

  const rows = await batchRows(tx, o.accountId, last.id)
  const fx = effectsOf(rows, last.id)
  const roots = [...fx.logged, ...fx.corrected.map((c) => c.now)].sort((a, b) => a.id - b.id)
  const touched = [...rows.map((r) => r.id), ...fx.corrected.map((c) => c.before)]
  if (touched.length === 0) return { kind: 'nothing' }
  await lockRows(tx, o.accountId, touched)

  // Where each movement stands now. Read after the locks, so a concurrent change has been committed or waits.
  const links = await followForward(
    tx,
    o.accountId,
    roots.map((r) => r.id),
  )
  const settled = await settledBatches(tx, [...new Set(links.map((l) => l.madeIn))])
  const heads = new Map<number, number>()
  const moved: BatchRow[] = []
  for (const root of roots) {
    const chain = links.filter((l) => l.root === root.id)
    const head = chain.at(-1)
    // Every step after the batch's own row was made by an undo or by a batch that was undone, and it is live.
    const asLeft =
      head?.live === true && chain.filter((l) => l.hop > 0).every((l) => settled.has(l.madeIn))
    if (asLeft && head) heads.set(root.id, head.id)
    else moved.push(root)
  }
  if (moved.length > 0) return { kind: 'stale', moved }
  // The heads are locked live: a change that slipped in between is refused here too.
  for (const head of new Set(heads.values())) {
    if (!(await lockLive(tx, o.accountId, head))) {
      const root = roots.find((r) => heads.get(r.id) === head)
      return { kind: 'stale', moved: root ? [root] : [] }
    }
  }

  const before = new Map(
    (
      await rowsByIds(
        tx,
        o.accountId,
        fx.corrected.map((c) => c.before),
      )
    ).map((r) => [r.id, r]),
  )
  const current = new Map(
    (await rowsByIds(tx, o.accountId, [...heads.values()])).map((r) => [r.id, r]),
  )
  const items: Undone[] = []
  let position = 0
  for (const root of roots) {
    const head = heads.get(root.id) as number
    const correction = fx.corrected.find((c) => c.now.id === root.id)
    if (!correction) {
      await softDelete(tx, head, o.inboundId)
      items.push({ kind: 'logged', movement: current.get(head) as MovementRow })
      continue
    }
    const original = before.get(correction.before) as MovementRow
    await copyVersion(tx, {
      accountId: o.accountId,
      inboundId: o.inboundId,
      position: position++,
      from: original.id,
      replaces: head,
    })
    items.push({ kind: 'corrected', from: current.get(head) as MovementRow, to: original })
  }
  for (const row of fx.deleted) {
    await copyVersion(tx, {
      accountId: o.accountId,
      inboundId: o.inboundId,
      position: position++,
      from: row.id,
      restoresIt: true,
    })
    items.push({ kind: 'deleted', movement: row })
  }
  await markUndone(tx, o.inboundId, last.id)
  return { kind: 'undone', batch: last.id, items }
}
