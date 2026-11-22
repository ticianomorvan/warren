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
