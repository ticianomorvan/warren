import type { Call, Movement } from '../src/core/commands'
import type { Sql } from '../src/core/db'
import type { Store } from '../src/core/history'
import { type Channel, type Committed, commit } from '../src/core/turn'

/** The clock of the core tests: an Argentine noon, so "today" is 2026-11-20. */
export const NOW = new Date('2026-11-20T15:00:00Z')
export const TODAY = '2026-11-20'
export const minutes = (n: number, from: Date = NOW) => new Date(from.getTime() + n * 60_000)
export const hours = (n: number, from: Date = NOW) => minutes(n * 60, from)

/** A person: the row every write locks. */
export async function newAccount(sql: Sql): Promise<number> {
  const [row] = await sql<
    { id: number }[]
  >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
  return (row as { id: number }).id
}

export const cafe = (o: Partial<Movement> = {}): Movement => ({
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  confidence: 'high',
  ...o,
})

/** Commits one turn of these calls, the reply being the lines of the writes. */
export function turn(
  sql: Sql,
  accountId: number,
  calls: Call[],
  o: { at?: Date; channel?: Channel; stores?: readonly Store[] } = {},
): Promise<Committed> {
  return commit(sql, {
    accountId,
    channel: o.channel ?? 'whatsapp',
    now: o.at ?? NOW,
    calls,
    ...(o.stores ? { stores: o.stores } : {}),
    compose: (done) => ({
      reply:
        done
          .map((d) => d.line)
          .filter((l) => l !== null)
          .join('\n') || 'ok',
    }),
  }) as Promise<Committed>
}

export const log = (...movements: Movement[]): Call => ({
  tool: 'log_movements',
  input: { movements },
})
export const undo: Call = { tool: 'undo_last', input: {} }

/** Every version of every movement, oldest first, as plain values. */
export const allMovements = (sql: Sql) => sql<
  {
    id: number
    entity: number
    made: number
    ended: number | null
    amount: string
    description: string
    logged: Date
  }[]
>`SELECT id::int, entity_id::int AS entity, made_in::int AS made, ended_in::int AS ended, amount::text AS amount,
    description, logged_at AS logged FROM movement ORDER BY id`
export const liveMovements = (sql: Sql) => sql<
  { entity: number; amount: string; description: string }[]
>`
  SELECT entity_id::int AS entity, amount::text AS amount, description FROM movement WHERE ended_at IS NULL ORDER BY id`
export const allFacts = (sql: Sql) =>
  sql<
    {
      id: number
      entity: number
      made: number
      ended: number | null
      kind: string
      key: string
      value: string
    }[]
  >`SELECT id::int, entity_id::int AS entity, made_in::int AS made, ended_in::int AS ended, kind, key, value FROM fact ORDER BY id`
export const liveFactList = (sql: Sql) => sql<{ entity: number; key: string; value: string }[]>`
  SELECT entity_id::int AS entity, key, value FROM fact WHERE ended_at IS NULL ORDER BY id`
export const allReminders = (sql: Sql) =>
  sql<
    {
      id: number
      entity: number
      made: number
      ended: number | null
      what: string
      due: Date | null
    }[]
  >`SELECT id::int, entity_id::int AS entity, made_in::int AS made, ended_in::int AS ended, what, next_due_at AS due FROM reminder ORDER BY id`
export const liveReminderList = (sql: Sql) => sql<{ entity: number; what: string }[]>`
  SELECT entity_id::int AS entity, what FROM reminder WHERE ended_at IS NULL AND next_due_at IS NOT NULL ORDER BY id`

export const correct = (id: number, changes: Record<string, string>): Call => ({
  tool: 'correct_movement',
  input: { id, changes },
})
export const remove = (id: number): Call => ({ tool: 'delete_movement', input: { id } })
export const remember = (
  key: string,
  value: string,
  kind: 'alias' | 'category' | 'note' = 'note',
): Call => ({
  tool: 'remember_fact',
  input: { kind, key, value },
})
export const forget = (target: { id: number } | { key: string }): Call => ({
  tool: 'forget_fact',
  input: { target },
})
export const forgetAll: Call = { tool: 'forget_all_confirmed', input: {} }
export const remind = (what: string, first: object = { month_day: 10 }, more: object = {}): Call =>
  ({ tool: 'set_reminder', input: { what, first, ...more } }) as Call
export const cancel = (id: number): Call => ({ tool: 'cancel_reminder', input: { id } })
