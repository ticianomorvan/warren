import { endFact, type FactRow, insertFact } from '../domain/facts'
import { endVersion, insertMovements, type MovementRow } from '../domain/movements'
import {
  endReminder,
  insertReminder,
  type ReminderRow,
  toRow as toReminder,
} from '../domain/reminders/db'
import { nextOccurrence } from '../domain/reminders/schedule'
import type { Sql } from './db'

/**
 * The one undo engine. A turn is the unit of work, and what it did is read off the versions: a version `made_in` the turn and a
 * version `ended_in` it, grouped by entity, give the entity's state before the turn (`pre`) and after it (`post`):
 *   - no `pre`, a `post`:  the turn made it (a log, a fact stored, a reminder set); undoing ends the live version;
 *   - a `pre` and a `post`: the turn changed it (a correction, a new value); undoing ends the live version and brings `pre` back
 *     as the next version of the same entity;
 *   - a `pre`, no `post`:   the turn ended it (a delete, a forget, a cancel); undoing brings `pre` back the same way.
 * Nothing is ever edited or removed: an undo ends versions and inserts versions, in its own turn.
 *
 * It undoes the account's newest turn that is not an undo, is not undone and did something (`lastBatch`, in commit order, which is
 * turn-id order), all or nothing. The stack is strict: if that turn cannot be undone, nothing older is reached (the person is told
 * why, and that an older change is fixed directly). It cannot be undone when a reminder's rules say it can never come back
 * (`blocked`: a one-off already sent, one with no occurrence left, a schedule that cannot be read).
 *
 * There is no "something changed it since" case: the caller holds the account lock and the turn is the newest one that is neither an
 * undo nor undone, so every later turn is settled and what the turn left stands as it left it. That is asserted (`asLeft`), not
 * handled: a failure means something wrote to the person's data outside `commit`.
 * Policy (which stores a channel may undo) comes in as `stores`.
 */

/** How long a turn can be undone: past it, the person is told and nothing is touched. */
export const UNDO_WINDOW_HOURS = 24

export const STORES = ['movement', 'fact', 'reminder'] as const
export type Store = (typeof STORES)[number]

/** What undoing one entity of the turn did. */
export type Undone =
  /** The turn logged it: it is deleted now. */
  | { kind: 'logged'; movement: MovementRow }
  /** The turn corrected it: it stands as it was before (`to`), no longer as the correction left it (`from`). */
  | { kind: 'corrected'; from: MovementRow; to: MovementRow }
  /** The turn deleted it: it is back. */
  | { kind: 'deleted'; movement: MovementRow }
  /** The turn stored it: it is forgotten now. */
  | { kind: 'fact_removed'; fact: FactRow }
  /** The turn changed its value: it has the old one again (`was` is the value undone). */
  | { kind: 'fact_reverted'; fact: FactRow; was: string }
  /** The turn forgot it: it is back. */
  | { kind: 'fact_restored'; fact: FactRow }
  /** The turn set it: it is cancelled now. */
  | { kind: 'reminder_removed'; reminder: ReminderRow }
  /** The turn cancelled it: it is back, with its next date worked out from now. */
  | { kind: 'reminder_restored'; reminder: ReminderRow }

/** Why a change can never be undone, so nothing older can be reached either. */
export type BlockedBy = 'sent' | 'past' | 'unreadable'

/** The reminders of a turn that can never be undone, as the turn left them (a stored schedule that cannot be read has no more than what it says). */
export interface Blocking {
  reminders: Pick<ReminderRow, 'id' | 'what'>[]
}

export type UndoResult =
  | { status: 'applied'; turn: number; items: Undone[] }
  /** The account has no turn left to undo. */
  | { status: 'nothing' }
  /** Their last turn is older than the window. */
  | { status: 'expired' }
  /** The turn changed a store this channel may not undo. Nothing was changed. */
  | { status: 'restricted' }
  /** A change of the turn can never be undone, which blocks the older ones too: nothing was changed. */
  | { status: 'blocked'; turn: number; blocking: Blocking; why: BlockedBy[] }

// ---- The versions of a store, read the same way for all three.

interface Version<R> {
  row: R
  madeIn: number
  endedIn: number | null
  live: boolean
}

type Raw = { madeIn: number; endedIn: number | null; live: boolean }

/** What an entity of the turn looked like, derived from its versions. */
interface Entity<R extends { version: number }> {
  pre: R | null
  post: R | null
  /** The newest version of the entity. */
  head: Version<R>
  /** Every version after `post` (after `pre` when there is none). */
  later: Version<R>[]
}

/** What an adapter read of a turn: the versions, and the ones it could not read (a reminder whose schedule no longer parses). */
interface Loaded<R> {
  versions: Version<R>[]
  unreadable: { id: number; what: string }[]
}

interface Adapter<R extends { id: number; version: number; loggedAt: Date }> {
  /** Every version of every entity the turn touched, locked, oldest first. */
  load(tx: Sql, accountId: number, turn: number): Promise<Loaded<R>>
  end(tx: Sql, version: number, turn: number): Promise<boolean>
  /** The next version of an entity, with the values of `from`. */
  restore(tx: Sql, o: { accountId: number; turn: number; from: R; now: Date }): Promise<R>
}

interface Plan<R extends { version: number }> {
  made: { post: R; head: R }[]
  changed: { pre: R; post: R; head: R }[]
  ended: { pre: R }[]
}

const movementAdapter: Adapter<MovementRow> = {
  async load(tx, accountId, turn) {
    const rows = await tx<(MovementRow & Raw)[]>`
      SELECT entity_id AS id, id AS version, direction, amount::text AS amount, currency,
        to_char(occurred_on, 'YYYY-MM-DD') AS date, description, category, payment, confidence,
        to_char(logged_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS time,
        logged_at AS "loggedAt", made_in AS "madeIn", ended_in AS "endedIn", ended_at IS NULL AS live
      FROM movement
      WHERE account_id = ${accountId} AND entity_id IN (
        SELECT entity_id FROM movement WHERE account_id = ${accountId} AND (made_in = ${turn} OR ended_in = ${turn}))
      ORDER BY movement.id FOR UPDATE`
    return {
      versions: rows.map(({ madeIn, endedIn, live, ...row }) => ({ row, madeIn, endedIn, live })),
      unreadable: [],
    }
  },
  end: (tx, version, turn) => endVersion(tx, version, turn),
  async restore(tx, { accountId, turn, from, now }) {
    const [row] = await insertMovements(tx, {
      accountId,
      turnId: turn,
      now,
      movements: [from],
      version: { entityId: from.id, loggedAt: from.loggedAt },
    })
    return row as MovementRow
  },
}

const factAdapter: Adapter<FactRow> = {
  async load(tx, accountId, turn) {
    const rows = await tx<(FactRow & Raw)[]>`
      SELECT entity_id AS id, id AS version, kind, key, value, logged_at AS "loggedAt",
        made_in AS "madeIn", ended_in AS "endedIn", ended_at IS NULL AS live
      FROM fact
      WHERE account_id = ${accountId} AND entity_id IN (
        SELECT entity_id FROM fact WHERE account_id = ${accountId} AND (made_in = ${turn} OR ended_in = ${turn}))
      ORDER BY fact.id FOR UPDATE`
    return {
      versions: rows.map(({ madeIn, endedIn, live, ...row }) => ({ row, madeIn, endedIn, live })),
      unreadable: [],
    }
  },
  end: (tx, version, turn) => endFact(tx, version, turn),
  restore: (tx, { accountId, turn, from, now }) =>
    insertFact(tx, {
      accountId,
      turnId: turn,
      now,
      kind: from.kind,
      key: from.key,
      value: from.value,
      entity: { id: from.id, loggedAt: from.loggedAt },
    }),
}

const reminderAdapter: Adapter<ReminderRow> = {
  async load(tx, accountId, turn) {
    // Locked: a sweep that is finishing a one-off waits, or has finished and the row is read as it is then.
    const rows = await tx<
      {
        id: number
        version: number
        what: string
        schedule: unknown
        next_due_at: Date | null
        loggedAt: Date
        madeIn: number
        endedIn: number | null
        live: boolean
      }[]
    >`
      SELECT entity_id AS id, id AS version, what, schedule, next_due_at, logged_at AS "loggedAt",
        made_in AS "madeIn", ended_in AS "endedIn", ended_at IS NULL AS live
      FROM reminder
      WHERE account_id = ${accountId} AND entity_id IN (
        SELECT entity_id FROM reminder WHERE account_id = ${accountId} AND (made_in = ${turn} OR ended_in = ${turn}))
      ORDER BY reminder.id FOR UPDATE`
    const versions: Version<ReminderRow>[] = []
    const unreadable: Loaded<ReminderRow>['unreadable'] = []
    for (const r of rows) {
      // A row whose schedule no longer parses cannot be shown or restored: the undo says so and touches nothing.
      const row = toReminder(r)
      if (row) versions.push({ row, madeIn: r.madeIn, endedIn: r.endedIn, live: r.live })
      else unreadable.push({ id: r.id, what: r.what })
    }
    return { versions, unreadable }
  },
  end: (tx, version, turn) => endReminder(tx, version, turn),
  restore: (tx, { accountId, turn, from, now }) =>
    insertReminder(tx, {
      accountId,
      turnId: turn,
      what: from.what,
      schedule: from.schedule,
      now,
      entity: { id: from.id, loggedAt: from.loggedAt },
    }),
}

/**
 * What can never come back, which blocks the turn and everything older: a one-off the sweep already sent has nothing left to take
 * back (`sent`), and one with no occurrence after now cannot be brought back (`past`).
 */
function reminderRules(plan: Plan<ReminderRow>, now: Date): { row: ReminderRow; why: BlockedBy }[] {
  const never: { row: ReminderRow; why: BlockedBy }[] = []
  for (const { head } of plan.made)
    if (head.nextDueAt === null) never.push({ row: head, why: 'sent' })
  const comes = [...plan.changed.map((c) => c.pre), ...plan.ended.map((e) => e.pre)]
  for (const pre of comes)
    if (!nextOccurrence(pre.schedule, now)) never.push({ row: pre, why: 'past' })
  return never
}

// ---- The newest turn that can be undone

export interface LastTurn {
  id: number
  /** Seconds between the turn and `now`. */
  ageSecs: number
}

/**
 * The account's newest turn, in commit order, that is not an undo, that no undo reverted and that did something: a version it made
 * that stands after it, or a version of an earlier turn that it ended. (A turn that made something and ended it itself is a net
 * of nothing and is skipped, so the turn before it can still be undone.)
 */
export async function lastTurn(tx: Sql, accountId: number, now: Date): Promise<LastTurn | null> {
  const effect = (table: 'movement' | 'fact' | 'reminder') => tx`
    EXISTS (SELECT 1 FROM ${tx(table)} v WHERE v.account_id = ${accountId} AND (
      (v.made_in = t.id AND v.ended_in IS DISTINCT FROM t.id) OR (v.ended_in = t.id AND v.made_in <> t.id)))`
  const [row] = await tx<LastTurn[]>`
    SELECT t.id AS id, extract(epoch FROM ${now}::timestamptz - t.created_at)::float8 AS "ageSecs"
    FROM turn t
    WHERE t.account_id = ${accountId} AND t.undoes IS NULL
      AND NOT EXISTS (SELECT 1 FROM turn u WHERE u.undoes = t.id)
      AND (${effect('movement')} OR ${effect('fact')} OR ${effect('reminder')})
    ORDER BY t.id DESC LIMIT 1`
  return row ?? null
}

/** Groups the versions by entity and derives each entity's state around `turn`. */
function entitiesOf<R extends { id: number; version: number }>(
  versions: Version<R>[],
  turn: number,
): Entity<R>[] {
  const byEntity = new Map<number, Version<R>[]>()
  for (const v of versions) byEntity.set(v.row.id, [...(byEntity.get(v.row.id) ?? []), v])
  const out: Entity<R>[] = []
  for (const all of byEntity.values()) {
    const pre = all.find((v) => v.endedIn === turn && v.madeIn !== turn) ?? null
    const posts = all.filter((v) => v.madeIn === turn && v.endedIn !== turn)
    const post = posts.at(-1) ?? null
    // Made and ended inside the turn: a net of nothing.
    if (!pre && !post) continue
    const from = (post ?? pre) as Version<R>
    out.push({
      pre: pre?.row ?? null,
      post: post?.row ?? null,
      head: all.at(-1) as Version<R>,
      // What came after, made by other turns: this turn's own other versions (a value replaced and forgotten in one message) are its own.
      later: all.filter((v) => v.row.version > from.row.version && v.madeIn !== turn),
    })
  }
  return out
}

interface Plans {
  movement: Plan<MovementRow>
  fact: Plan<FactRow>
  reminder: Plan<ReminderRow>
}
const emptyPlan = <R extends { version: number }>(): Plan<R> => ({
  made: [],
  changed: [],
  ended: [],
})

/**
 * Undoes the account's last turn as one step, in the commit transaction of the turn that asks (`turn`). All or nothing. The
 * caller holds the account lock, so no other write runs between the reads and the writes.
 */
export async function undoLast(
  tx: Sql,
  o: { accountId: number; turn: number; now: Date; stores: readonly Store[] },
): Promise<UndoResult> {
  const last = await lastTurn(tx, o.accountId, o.now)
  if (!last) return { status: 'nothing' }
  if (last.ageSecs > UNDO_WINDOW_HOURS * 3600) return { status: 'expired' }

  const read = {
    movement: await movementAdapter.load(tx, o.accountId, last.id),
    fact: await factAdapter.load(tx, o.accountId, last.id),
    reminder: await reminderAdapter.load(tx, o.accountId, last.id),
  }
  // A reminder of the turn that cannot be read cannot be taken back, and the stack is strict: the turn is blocked, by name.
  if (read.reminder.unreadable.length > 0 && o.stores.includes('reminder')) {
    return {
      status: 'blocked',
      turn: last.id,
      blocking: { reminders: read.reminder.unreadable },
      why: ['unreadable'],
    }
  }
  const loaded = {
    movement: read.movement.versions,
    fact: read.fact.versions,
    reminder: read.reminder.versions,
  }
  const plans: Plans = { movement: emptyPlan(), fact: emptyPlan(), reminder: emptyPlan() }
  const touched = new Set<Store>()

  const classify = <R extends { id: number; version: number; loggedAt: Date }>(
    store: Store,
    versions: Version<R>[],
    plan: Plan<R>,
  ) => {
    for (const e of entitiesOf(versions, last.id)) {
      touched.add(store)
      // As the turn left it: what it made is still live (a later turn that changed it was undone, so its version is live again),
      // what it ended is still ended. Under the account lock this always holds; if it does not, something wrote outside `commit`.
      const asLeft = e.post ? e.head.live : !e.head.live
      if (!asLeft) {
        throw new Error(
          `undo of turn ${last.id}: ${store} ${(e.post ?? e.pre)?.id} is not as the turn left it, and no later turn is open`,
        )
      }
      if (e.post && !e.pre) plan.made.push({ post: e.post, head: e.head.row })
      else if (e.post && e.pre) plan.changed.push({ pre: e.pre, post: e.post, head: e.head.row })
      else if (e.pre) plan.ended.push({ pre: e.pre })
    }
  }
  classify('movement', loaded.movement, plans.movement)
  classify('fact', loaded.fact, plans.fact)
  classify('reminder', loaded.reminder, plans.reminder)

  if (touched.size === 0) return { status: 'nothing' }
  if ([...touched].some((s) => !o.stores.includes(s))) return { status: 'restricted' }

  // What can never come back blocks the turn, and so everything older.
  const never = reminderRules(plans.reminder, o.now)
  if (never.length > 0) {
    return {
      status: 'blocked',
      turn: last.id,
      blocking: { reminders: never.map((n) => n.row) },
      why: [...new Set(never.map((n) => n.why))],
    }
  }

  const items: Undone[] = []
  const done = async <R extends { id: number; version: number; loggedAt: Date }>(
    adapter: Adapter<R>,
    plan: Plan<R>,
    toItem: {
      made: (head: R) => Undone
      changed: (head: R, restored: R) => Undone
      ended: (restored: R) => Undone
    },
  ) => {
    const base = { accountId: o.accountId, turn: o.turn, now: o.now }
    const forward = [
      ...plan.made.map((m) => ({
        at: m.post.version,
        run: async () => {
          await adapter.end(tx, m.head.version, o.turn)
          return toItem.made(m.head)
        },
      })),
      ...plan.changed.map((c) => ({
        at: c.post.version,
        run: async () => {
          await adapter.end(tx, c.head.version, o.turn)
          return toItem.changed(c.head, await adapter.restore(tx, { ...base, from: c.pre }))
        },
      })),
    ].sort((a, b) => a.at - b.at)
    for (const step of forward) items.push(await step.run())
    for (const e of [...plan.ended].sort((a, b) => a.pre.version - b.pre.version)) {
      items.push(toItem.ended(await adapter.restore(tx, { ...base, from: e.pre })))
    }
  }
  await done(movementAdapter, plans.movement, {
    made: (head) => ({ kind: 'logged', movement: head }),
    changed: (head, restored) => ({ kind: 'corrected', from: head, to: restored }),
    ended: (restored) => ({ kind: 'deleted', movement: restored }),
  })
  await done(factAdapter, plans.fact, {
    made: (head) => ({ kind: 'fact_removed', fact: head }),
    changed: (head, restored) => ({ kind: 'fact_reverted', fact: restored, was: head.value }),
    ended: (restored) => ({ kind: 'fact_restored', fact: restored }),
  })
  await done(reminderAdapter, plans.reminder, {
    made: (head) => ({ kind: 'reminder_removed', reminder: head }),
    changed: (_head, restored) => ({ kind: 'reminder_restored', reminder: restored }),
    ended: (restored) => ({ kind: 'reminder_restored', reminder: restored }),
  })
  return { status: 'applied', turn: last.id, items }
}

/** What an undo did, for an audit entry: which turn and what became of each entity; nothing for an undo that did nothing. */
export function undoDetail(undo: UndoResult): string | undefined {
  if (undo.status === 'applied') {
    const item = (u: Undone) =>
      'reminder' in u
        ? u.reminder.id
        : 'fact' in u
          ? u.fact.id
          : 'movement' in u
            ? u.movement.id
            : u.from.id
    return `undid turn ${undo.turn}: ${undo.items.map((u) => `${u.kind} ${item(u)}`).join(', ')}`
  }
  if (undo.status === 'blocked') {
    return `blocked (${undo.why.join(', ')}): ${undo.blocking.reminders.map((r) => r.id).join(', ')}`
  }
  return undefined
}
