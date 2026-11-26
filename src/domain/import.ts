import type { Call } from '../core/commands'
import type { Sql } from '../core/db'
import { checkValues } from '../core/guards'
import { commit } from '../core/turn'
import { argentinaToday } from '../time'
import { countLive, MAX_LIVE_MOVEMENTS } from './movements'

/** What `log_movements` takes in one call: an import is cut into calls of this size. */
const PER_CALL = 10
/** The most rows one import takes, so the account lock is held for seconds, not minutes. */
export const MAX_ROWS = 5000

export interface Problem {
  /** The first and last row (1-based) of the call that was refused. */
  rows: [number, number]
  message: string
}

export type ImportResult =
  | { status: 'checked'; movements: number }
  | { status: 'imported'; turn: number; movements: number }
  | { status: 'refused'; problems: Problem[] }
  /** The same rows were already imported into this account, and that import is not undone. */
  | { status: 'already'; turn: number }
  /** The account would hold more than `MAX_LIVE_MOVEMENTS`: nothing was written. */
  | { status: 'full'; live: number }

/**
 * A person's backlog (a spreadsheet, old statements) as one turn for the client `cli`, through the same `checkValues` and `commit` as
 * MCP. Every chunk of 10 rows is one `log_movements` call, all checked before anything is written: one refusal and nothing is.
 * Without `into`, it only checks. Being one turn, the import is one step of the undo stack: `warren_undo_last` takes it all back.
 */
export async function importMovements(o: {
  rows: unknown[]
  now?: Date
  into?: { sql: Sql; accountId: number }
}): Promise<ImportResult> {
  const now = o.now ?? new Date()
  const env = { today: argentinaToday(now) }
  if (o.rows.length > MAX_ROWS) {
    return {
      status: 'refused',
      problems: [{ rows: [MAX_ROWS + 1, o.rows.length], message: `at most ${MAX_ROWS} rows` }],
    }
  }
  const calls: Call[] = []
  const problems: Problem[] = []
  for (let start = 0; start < o.rows.length; start += PER_CALL) {
    const chunk = o.rows.slice(start, start + PER_CALL)
    const checked = checkValues('log_movements', { movements: chunk }, env)
    if (checked.kind === 'ok') calls.push(checked.call)
    else
      problems.push({
        rows: [start + 1, start + chunk.length],
        message:
          checked.kind === 'rejected'
            ? checked.message
            : checked.kind === 'declined'
              ? `declined: ${checked.declined}`
              : 'not a write',
      })
  }
  if (problems.length > 0) return { status: 'refused', problems }
  if (!o.into) return { status: 'checked', movements: o.rows.length }
  const { sql, accountId } = o.into
  const committed = await commit(sql, {
    accountId,
    client: 'cli',
    now,
    calls,
    // Under the lock: the same file run twice (a dropped terminal, a retry) must not write it twice, and the account's cap holds.
    guard: async (tx: Sql): Promise<{ stop: { turn: number } | { live: number } } | undefined> => {
      const live = await countLive(tx, accountId)
      if (live + o.rows.length > MAX_LIVE_MOVEMENTS) return { stop: { live } }
      const [prior] = await tx<{ id: number }[]>`
        SELECT t.id::int AS id FROM turn t
        WHERE t.account_id = ${accountId} AND t.client = 'cli'
          -- A stored call also carries its outcome (status, effect): compare what was asked, in order.
          AND (SELECT jsonb_agg(jsonb_build_object('tool', c -> 'tool', 'input', c -> 'input') ORDER BY n)
               FROM jsonb_array_elements(t.calls) WITH ORDINALITY AS e (c, n)) = ${tx.json(calls as never)}
          AND NOT EXISTS (SELECT 1 FROM turn u WHERE u.undoes = t.id)
        LIMIT 1`
      return prior ? { stop: { turn: prior.id } } : undefined
    },
  })
  if ('stop' in committed) {
    return 'turn' in committed.stop
      ? { status: 'already', turn: committed.stop.turn }
      : { status: 'full', live: committed.stop.live }
  }
  if ('unchanged' in committed) throw new Error('the import wrote nothing')
  return { status: 'imported', turn: committed.turn, movements: o.rows.length }
}

/** The account a Google email belongs to (the address the person signed in with), or null. */
export async function accountOfEmail(sql: Sql, email: string): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    SELECT warren_account_id::int AS id FROM auth_user
    WHERE lower(email) = lower(${email.trim()}) AND warren_account_id IS NOT NULL`
  return row?.id ?? null
}
