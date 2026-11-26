import { newestLiveId } from '../domain/movements'
import { argentinaToday } from '../time'
import { applyCall, type Outcome } from './apply'
import { type Call, writes } from './commands'
import type { Sql } from './db'
import { describe } from './describe'

/**
 * The commit point. A turn is one unit of work, and its row is inserted only here, last, in the transaction that made the changes:
 * its existence is the commit point (the versions refer to it with a deferred key, so a transaction that never inserts its turn
 * cannot commit a version). One transaction, in this order:
 *   1. the account lock, the one lock of a person's data: every write transaction takes it first, so the writes of one account
 *      are serialized and turn ids are in commit order. It is private to this module;
 *   2. `guard`: what depends on the account as it is under the lock (a request's replay, the movement cap), and may stop the turn;
 *   3. `applyCall` for each write, in order;
 *   4. the turn row, with the record code rendered for the changes; then `after`.
 */

/** Who made the turn: an OAuth client id (from the verified token), or `cli` for the import command. */
export type Client = string

/** A call of the turn and what came of it: an outcome for a write, nothing for a read. */
export interface Done {
  call: Call
  outcome: Outcome | null
  /** The Spanish line code rendered for the outcome. */
  line: string | null
}

export interface CommitInput<S = never> {
  accountId: number
  client: Client
  /** The instant of the call: the turn's `created_at` and `logged_at`, and what an undo counts its window from. */
  now: Date
  /** The calls of the turn, in order. The writes are applied; the others are carried in `calls` as sent. */
  calls: Call[]
  /**
   * After the account lock, before any write: what depends on the account's state as it is under the lock (a request's replay, the
   * cap on movements). `{stop}` ends the transaction with nothing written and hands `stop` back.
   */
  guard?: (tx: Sql) => Promise<{ stop: S } | undefined>
  /** When no write changed anything, ends the transaction with no turn and says what each call came to (`{unchanged}`). */
  requireChange?: boolean
  /** Runs inside the transaction after the turn row exists (an MCP request's row). */
  after?: (tx: Sql, turn: { id: number } & Omit<Committed, 'turn'>) => Promise<void>
  /** The call held something Warren must not keep: no call's input is stored. */
  scrub?: boolean
}

export interface Committed {
  turn: number
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

/** Runs the transaction of a turn. Returns `{stop}` when `guard` stopped it, `{unchanged}` when `requireChange` is set and nothing changed. */
export function commit(
  sql: Sql,
  i: Omit<CommitInput, 'guard' | 'requireChange'>,
): Promise<Committed>
export function commit<S>(sql: Sql, i: CommitInput<S>): Promise<Committed | Stopped<S> | Unchanged>
export function commit<S>(
  sql: Sql,
  i: CommitInput<S>,
): Promise<Committed | Stopped<S> | Unchanged> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    await lockAccount(tx, i.accountId)
    const stopped = i.guard ? await i.guard(tx) : undefined
    if (stopped) return stopped
    // The turn's id is taken after the lock, so ids of one account run in commit order.
    const [reserved] = await tx<{ id: number }[]>`
      SELECT nextval(pg_get_serial_sequence('turn', 'id')) AS id`
    const turnId = (reserved as { id: number }).id
    const today = argentinaToday(i.now)
    const newest = await newestLiveId(tx, i.accountId)
    const done: Done[] = []
    for (const call of i.calls) {
      if (!writes(call)) {
        done.push({ call, outcome: null, line: null })
        continue
      }
      const outcome = await applyCall(tx, { accountId: i.accountId, turnId, at: i.now }, call)
      done.push({ call, outcome, line: describe(outcome, { today, newest }) })
    }
    const changed = done.filter((d) => d.outcome?.effect && d.line !== null)
    if (i.requireChange && !done.some((d) => d.outcome?.effect)) {
      // No outcome wrote anything (a refusal, a no-op), so there is nothing to keep: no turn, and the lock goes with the transaction.
      return { unchanged: done }
    }
    const record = changed.length > 0 ? changed.map((d) => d.line).join('\n') : null
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
      INSERT INTO turn (id, account_id, client, created_at, calls, record, undoes)
      VALUES (${turnId}, ${i.accountId}, ${i.client}, ${i.now}, ${tx.json(calls as never)}, ${record}, ${undoes})`
    if (i.after) await i.after(tx, { id: turnId, record, done })
    return { turn: turnId, record, done }
  })
}
