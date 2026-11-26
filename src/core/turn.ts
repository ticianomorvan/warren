import { newestLiveId } from '../domain/movements'
import { argentinaToday } from '../time'
import { applyCall, type Outcome } from './apply'
import { type Call, labelOf, type Then, writes } from './commands'
import type { Sql } from './db'
import { describe } from './describe'

/**
 * The commit point. A turn is one unit of work on any channel, and its row is inserted only here, last, in the transaction that
 * made the changes: its existence is the commit point (the versions refer to it with a deferred key, so a transaction that never
 * inserts its turn cannot commit a version). One transaction, in this order:
 *   1. `claim`: read-only, before the lock (the WhatsApp message is still this worker's);
 *   2. the account lock, the one lock of a person's data: every write transaction takes it first, so the writes of one account
 *      are serialized and turn ids are in commit order. It is private to this module;
 *   3. `guard`: what depends on the account as it is under the lock, and may stop the turn;
 *   4. `applyCall` for each write, in order;
 *   5. `compose`: the reply, rendered after the writes in the same transaction (so a read of the turn sees them);
 *   6. the turn row, with the record code rendered for the changes, the reply and the question the reply asked; then `after`.
 */

export type Channel = 'whatsapp' | 'mcp' | 'cli'

/** A "which one?" the reply asked: the options by number, and what an option does once picked. */
export interface Question {
  /** `v` is the version of the movement the question showed: an answer applies to that one, or to nothing. */
  options: { n: number; id: number; v?: number }[]
  then: Then | { do: 'forget_all' } | { do: 'link'; link_id: number }
}

/** A call of the turn and what came of it: an outcome for a write, nothing for the rest. */
export interface Done {
  call: Call
  outcome: Outcome | null
  /** The Spanish line code rendered for the outcome. */
  line: string | null
}

/** The reply of a turn, and the question it asked. */
export interface Composed {
  reply: string
  question?: Question | null
}

export interface CommitInput<S = never> {
  accountId: number
  channel: Channel
  /** The instant of the message: the turn's `created_at` and `logged_at`, and what an undo counts its window from. WhatsApp gives its own; an MCP request is now. */
  now: Date
  /**
   * The scheduling clock, read at the commit point: a reminder's schedule is counted from it, so one that has gone by while the turn
   * waited is `past`, not stored in the past. Default `now`.
   */
  clock?: () => Date
  /** The calls of the turn, in order. The writes are applied; the others (answers, asks, reads) are carried in `calls` as sent. */
  calls: Call[]
  /** Before the account lock, read-only: the WhatsApp claim's guard row. False ends the transaction with nothing written (`null`). */
  claim?: (tx: Sql) => Promise<boolean>
  /**
   * After the account lock, before any write: what depends on the account's state as it is under the lock (an MCP request's replay, the
   * address a reminder needs, the sign-in's own SQL). `{stop}` ends the transaction with nothing written and hands `stop` back.
   */
  guard?: (tx: Sql) => Promise<{ stop: S } | undefined>
  /** When no write changed anything, ends the transaction with no turn and says what each call came to (`{unchanged}`). */
  requireChange?: boolean
  /**
   * The reply, and the question it asked: composed from what each call came to, inside the transaction and after the writes, so a read
   * of the turn ("cuánto llevo hoy") sees them. `record` is the lines of the changes, or null.
   */
  compose: (
    tx: Sql,
    done: Done[],
    record: string | null,
    turnId: number,
  ) => Composed | Promise<Composed>
  /** Runs inside the transaction after the turn row exists (the WhatsApp message's `turn_id`, an MCP request's row). */
  after?: (tx: Sql, turn: { id: number } & Omit<Committed, 'turn'>) => Promise<void>
  /** The message held something Warren must not keep: no call's input is stored. */
  scrub?: boolean
  /** Overrides the label derived from the calls. */
  label?: string
}

export interface Committed {
  turn: number
  reply: string
  record: string | null
  done: Done[]
}

/** The guard stopped the turn: nothing was written. */
export interface Stopped<S> {
  stop: S
}
/** `requireChange` was set and no write changed anything: nothing was written. */
export interface Unchanged {
  unchanged: Done[]
}

/** Takes the account lock: first in every write transaction, and held until it ends. Only `commit` calls it. */
async function lockAccount(tx: Sql, accountId: number): Promise<void> {
  await tx`SELECT 1 FROM account WHERE id = ${accountId} FOR NO KEY UPDATE`
}

/**
 * Runs the transaction of a turn. Returns null, with nothing written, when `claim` says the claim was lost; `{stop}` when `guard`
 * stopped it; `{unchanged}` when `requireChange` is set and nothing changed.
 */
export function commit(
  sql: Sql,
  i: Omit<CommitInput, 'guard' | 'requireChange'>,
): Promise<Committed | null>
export function commit<S>(
  sql: Sql,
  i: CommitInput<S>,
): Promise<Committed | Stopped<S> | Unchanged | null>
export function commit<S>(
  sql: Sql,
  i: CommitInput<S>,
): Promise<Committed | Stopped<S> | Unchanged | null> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    if (i.claim && !(await i.claim(tx))) return null
    await lockAccount(tx, i.accountId)
    const stopped = i.guard ? await i.guard(tx) : undefined
    if (stopped) return stopped
    // The turn's id is taken after the lock, so ids of one account run in commit order.
    const [reserved] = await tx<{ id: number }[]>`
      SELECT nextval(pg_get_serial_sequence('turn', 'id')) AS id`
    const turnId = (reserved as { id: number }).id
    const today = argentinaToday(i.now)
    const clock = i.clock ? new Date(Math.max(i.now.getTime(), i.clock().getTime())) : i.now
    const newest = await newestLiveId(tx, i.accountId)
    const done: Done[] = []
    for (const call of i.calls) {
      if (!writes(call)) {
        done.push({ call, outcome: null, line: null })
        continue
      }
      const outcome = await applyCall(
        tx,
        {
          accountId: i.accountId,
          turnId,
          at: i.now,
          now: clock,
        },
        call,
      )
      done.push({ call, outcome, line: describe(outcome, { today, newest }) })
    }
    const changed = done.filter((d) => d.outcome?.effect && d.line !== null)
    if (i.requireChange && !done.some((d) => d.outcome?.effect)) {
      // No outcome wrote anything (a refusal, a no-op), so there is nothing to keep: no turn, and the lock goes with the transaction.
      return { unchanged: done }
    }
    const record = changed.length > 0 ? changed.map((d) => d.line).join('\n') : null
    const { reply, question } = await i.compose(tx, done, record, turnId)
    const undone = done.find(
      (d) => d.outcome?.tool === 'undo_last' && d.outcome.status === 'applied',
    )
    const undoes =
      undone?.outcome?.tool === 'undo_last' && undone.outcome.status === 'applied'
        ? undone.outcome.turn
        : null
    const calls = done.map(({ call, outcome }) => ({
      tool: call.tool,
      ...(i.scrub ? {} : { input: call.input }),
      ...(outcome ? { status: outcome.status, effect: outcome.effect } : {}),
    }))
    await tx`
      INSERT INTO turn (id, account_id, channel, created_at, label, calls, record, reply, question, undoes)
      VALUES (${turnId}, ${i.accountId}, ${i.channel}, ${i.now}, ${i.label ?? labelOf(i.calls)},
        ${tx.json(calls as never)}, ${record}, ${reply}, ${question ? tx.json(question as never) : null}, ${undoes})`
    if (i.after) await i.after(tx, { id: turnId, reply, record, done })
    return { turn: turnId, reply, record, done }
  })
}
