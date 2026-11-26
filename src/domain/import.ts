import type { Call } from '../core/commands'
import type { Sql } from '../core/db'
import { checkValues } from '../core/guards'
import { commit } from '../core/turn'
import { argentinaToday } from '../time'

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

/**
 * A person's backlog (a spreadsheet, old statements) as one turn on the `cli` channel, through the same `checkValues` and `commit` as
 * WhatsApp and MCP. Every chunk of 10 rows is one `log_movements` call, all checked before anything is written: one refusal and nothing
 * is. Without `into`, it only checks. Being one turn, the import is one step of the undo stack: "deshacer" takes it all back.
 * `checkTurn` is not run: its rules are a conversation's (ids shown, the per-message cap), and an import has none.
 */
export async function importMovements(o: {
  rows: unknown[]
  now?: Date
  into?: { sql: Sql; accountId: number }
}): Promise<ImportResult> {
  const now = o.now ?? new Date()
  const env = { today: argentinaToday(now), now }
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
    channel: 'cli',
    now,
    calls,
    label: 'import',
    // Under the lock: the same file run twice (a dropped terminal, a retry) must not write it twice.
    guard: async (tx: Sql): Promise<{ stop: number } | undefined> => {
      const [prior] = await tx<{ id: number }[]>`
        SELECT t.id::int AS id FROM turn t
        WHERE t.account_id = ${accountId} AND t.label = 'import'
          -- A stored call also carries its outcome (status, effect): compare what was asked, in order.
          AND (SELECT jsonb_agg(jsonb_build_object('tool', c -> 'tool', 'input', c -> 'input') ORDER BY n)
               FROM jsonb_array_elements(t.calls) WITH ORDINALITY AS e (c, n)) = ${tx.json(calls as never)}
          AND NOT EXISTS (SELECT 1 FROM turn u WHERE u.undoes = t.id)
        LIMIT 1`
      return prior ? { stop: prior.id } : undefined
    },
    compose: () => ({ reply: `Importé ${o.rows.length} movimientos.` }),
  })
  if (committed && 'stop' in committed) return { status: 'already', turn: committed.stop }
  if (!committed || 'unchanged' in committed) throw new Error('the import wrote nothing')
  return { status: 'imported', turn: committed.turn, movements: o.rows.length }
}

/** The account a WhatsApp number (`wa_id`, digits only) belongs to, or null. */
export async function accountOfWaId(sql: Sql, waId: string): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    SELECT account_id::int AS id FROM account_address WHERE channel = 'whatsapp' AND address = ${waId}`
  return row?.id ?? null
}
