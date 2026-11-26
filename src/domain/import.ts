import type { Call } from '../core/commands'
import type { Sql } from '../core/db'
import { checkValues, type Env } from '../core/guards'
import { commit } from '../core/turn'
import { argentinaToday } from '../time'

/** What `log_movements` takes in one call: an import is cut into calls of this size. */
const PER_CALL = 10

export interface Problem {
  /** The first and last row (1-based) of the call that was refused. */
  rows: [number, number]
  message: string
}

export type ImportResult =
  | { status: 'imported'; turn: number; movements: number }
  | { status: 'refused'; problems: Problem[] }

/** Each chunk of rows as a checked `log_movements` call, by the same `checkValues` as MCP. Writes nothing. */
export function checkRows(rows: unknown[], env: Env): { calls: Call[]; problems: Problem[] } {
  const calls: Call[] = []
  const problems: Problem[] = []
  if (rows.length === 0) problems.push({ rows: [0, 0], message: 'no rows' })
  for (let start = 0; start < rows.length; start += PER_CALL) {
    const chunk = rows.slice(start, start + PER_CALL)
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
  return { calls, problems }
}

/**
 * Writes a backlog of movements for one person as one turn on the `cli` channel, through the same guards and the same `commit` as
 * WhatsApp and MCP. Each row is a `log_movements` movement (strings, a day not after today). Every chunk is checked before anything is
 * written: one refusal and nothing is. Being one turn, the whole import is one step of the undo stack: "deshacer" takes it all back.
 */
export async function importMovements(
  sql: Sql,
  o: { accountId: number; rows: unknown[]; now?: Date },
): Promise<ImportResult> {
  const now = o.now ?? new Date()
  const { calls, problems } = checkRows(o.rows, { today: argentinaToday(now), now })
  if (problems.length > 0) return { status: 'refused', problems }
  const committed = await commit(sql, {
    accountId: o.accountId,
    channel: 'cli',
    now,
    calls,
    label: 'import',
    compose: () => ({ reply: `Importé ${o.rows.length} movimientos.` }),
  })
  if (committed === null || 'stop' in committed || 'unchanged' in committed) {
    throw new Error('the import wrote nothing')
  }
  return { status: 'imported', turn: committed.turn, movements: o.rows.length }
}

/** The account a WhatsApp number (`wa_id`, digits only) belongs to, or null. */
export async function accountOfWaId(sql: Sql, waId: string): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    SELECT account_id::int AS id FROM account_address WHERE channel = 'whatsapp' AND address = ${waId}`
  return row?.id ?? null
}
