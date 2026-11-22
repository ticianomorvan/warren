import { newestLiveId } from '../domain/movements'
import { argentinaToday } from '../time'
import { applyCall, type Outcome } from './apply'
import { type Call, labelOf, type Then, writes } from './commands'
import type { Sql } from './db'
import { describe } from './describe'
import type { Store } from './history'

/**
 * The commit point. A turn is one unit of work on any channel, and its row is inserted only here, last, in the transaction that
 * made the changes: its existence is the commit point (the versions refer to it with a deferred key, so a transaction that never
 * inserts its turn cannot commit a version). One transaction, in this order:
 *   1. the account lock, the one lock of a person's data: every write transaction takes it first, so the writes of one account
 *      are serialized and turn ids are in commit order;
 *   2. `applyCall` for each write, in order;
 *   3. the turn row, with the record code rendered for the changes, the reply and the question the reply asked.
 */

export type Channel = 'whatsapp' | 'mcp' | 'cli'

/** A "which one?" the reply asked: the options by number, and what an option does once picked. */
export interface Question {
  options: { n: number; id: number }[]
  then: Then | { do: 'forget_all' } | { do: 'link'; link_id: number }
}

/** A call of the turn and what came of it: an outcome for a write, nothing for the rest. */
export interface Done {
  call: Call
  outcome: Outcome | null
  /** The Spanish line code rendered for the outcome. */
  line: string | null
}

export interface CommitInput {
  accountId: number
  channel: Channel
  /** The instant of the message: the turn's `created_at`, and what an undo and a reminder count from. WhatsApp gives its own; an MCP request is now. */
  now: Date
  /** The calls of the turn, in order. The writes are applied; the others (answers, asks, reads) are carried in `calls` as sent. */
  calls: Call[]
  /** The stores an undo of this channel may reach. Default: all. */
  stores?: readonly Store[]
  /** Runs inside the transaction before the account lock (a WhatsApp claim's guard row); false ends it with nothing written. */
  before?: (tx: Sql) => Promise<boolean>
  /** The reply, and the question it asked: composed from what each call came to. `record` is the lines of the changes, or null. */
  compose: (done: Done[], record: string | null) => { reply: string; question?: Question | null }
  /** Runs inside the transaction after the turn row exists (the WhatsApp message's `turn_id`, an MCP request's row). */
  after?: (tx: Sql, turn: { id: number; reply: string; record: string | null }) => Promise<void>
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

/** The account lock: taken first by every write transaction. Held until the transaction ends. */
export async function lockAccount(tx: Sql, accountId: number): Promise<void> {
  await tx`SELECT 1 FROM account WHERE id = ${accountId} FOR NO KEY UPDATE`
}

/** Runs the transaction of a turn. Returns null, with nothing written, when `before` says the claim was lost. */
export function commit(sql: Sql, i: CommitInput): Promise<Committed | null> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    if (i.before && !(await i.before(tx))) return null
    await lockAccount(tx, i.accountId)
    // The turn's id is taken after the lock, so ids of one account run in commit order.
    const [reserved] = await tx<{ id: number }[]>`
      SELECT nextval(pg_get_serial_sequence('turn', 'id'))::int AS id`
    const turnId = (reserved as { id: number }).id
    const today = argentinaToday(i.now)
    const newest = await newestLiveId(tx, i.accountId)
    const done: Done[] = []
    for (const call of i.calls) {
      if (!writes(call)) {
        done.push({ call, outcome: null, line: null })
        continue
      }
      const outcome = await applyCall(
        tx,
        { accountId: i.accountId, turnId, now: i.now, ...(i.stores ? { stores: i.stores } : {}) },
        call,
      )
      done.push({ call, outcome, line: describe(outcome, { today, newest }) })
    }
    const changed = done.filter((d) => d.outcome?.effect && d.line !== null)
    const record = changed.length > 0 ? changed.map((d) => d.line).join('\n') : null
    const { reply, question } = i.compose(done, record)
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
    if (i.after) await i.after(tx, { id: turnId, reply, record })
    return { turn: turnId, reply, record, done }
  })
}
