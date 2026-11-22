import type { Category, GROUPS } from '../core/commands'
import type { Sql } from '../core/db'
import { normalizeText } from '../core/values'
import type { DateRange } from '../time'

export type GroupBy = (typeof GROUPS)[number]
export const isTimeGroup = (by: GroupBy) => by === 'day' || by === 'week' || by === 'month'

/** One total of a summary: a direction and a currency. Currencies and directions are never mixed. */
export interface QueryTotal {
  direction: 'in' | 'out'
  currency: 'ARS' | 'USD'
  /** The SQL sum, as a decimal string. */
  total: string
  count: number
}

/** One total of a group: a category, a folded payment ('' for none), a day, the Monday of a week or a month (yyyy-mm). */
export interface GroupTotal extends QueryTotal {
  key: string
  /** A payment as it was written; null for every other group. */
  label: string | null
}

export interface QueryFilter {
  direction: 'in' | 'out' | null
  category: Category | null
  /** Matched loosely: case- and accent-insensitive, contained in the stored payment. */
  payment: string | null
  /** Words of the description, every one contained in it (accents and case ignored). */
  description: string | null
  range: DateRange
}

/** What a summary shows of one range: the totals of each direction and currency and, when grouped, the groups under them. */
export interface SummaryRows {
  totals: QueryTotal[]
  groups: GroupTotal[]
}

const ACCENTS = ["'áéíóúüñÁÉÍÓÚÜÑ'", "'aeiouunAEIOUUN'"] as const
const folded = (column: string) =>
  `lower(translate(coalesce(${column}, ''), ${ACCENTS[0]}, ${ACCENTS[1]}))`

/** A payment is grouped without regard to case or accents and shown as written; a week is its Monday (dates cast to `timestamp` first). */
const GROUP_SQL: Record<Exclude<GroupBy, 'none'>, string> = {
  category: 'category',
  payment: folded("btrim(coalesce(payment, ''))"),
  day: `to_char(occurred_on, 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', occurred_on::timestamp), 'YYYY-MM-DD')`,
  month: `to_char(date_trunc('month', occurred_on::timestamp), 'YYYY-MM')`,
}

/** The movements of a summary: live ones of the account, in the range, that pass every filter. */
function matching(sql: Sql, accountId: number, f: QueryFilter) {
  const needle = f.payment ? normalizeText(f.payment) : ''
  const words = normalizeText(f.description ?? '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  return sql`
    account_id = ${accountId} AND ended_at IS NULL
      AND occurred_on BETWEEN ${f.range.from}::date AND ${f.range.to}::date
      ${f.direction ? sql`AND direction = ${f.direction}` : sql``}
      ${f.category ? sql`AND category = ${f.category}` : sql``}
      ${
        words.length > 0
          ? sql`AND ${sql.unsafe(folded('description'))} LIKE ALL (${words.map(like)}::text[])`
          : sql``
      }
      ${needle ? sql`AND position(${needle}::text IN ${sql.unsafe(folded('payment'))}) > 0` : sql``}`
}

/** Totals per direction and currency, summed by the database. Currencies are never converted. */
export function queryTotals(sql: Sql, accountId: number, f: QueryFilter) {
  return sql<QueryTotal[]>`
    SELECT direction, currency, sum(amount)::text AS total, count(*)::int AS count
    FROM movement WHERE ${matching(sql, accountId, f)}
    GROUP BY direction, currency
    ORDER BY direction DESC, currency`
}

/** Per group within each direction and currency: what was bought or paid biggest first, time oldest first. */
export function queryGroups(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
  by: Exclude<GroupBy, 'none'>,
) {
  const key = sql.unsafe(GROUP_SQL[by])
  return sql<GroupTotal[]>`
    SELECT direction, currency, ${key} AS key,
      ${by === 'payment' ? sql`coalesce(min(nullif(btrim(payment), '')), '')` : sql`NULL::text`} AS label,
      sum(amount)::text AS total, count(*)::int AS count
    FROM movement WHERE ${matching(sql, accountId, f)}
    GROUP BY direction, currency, ${key}
    ORDER BY direction DESC, currency, ${isTimeGroup(by) ? sql`${key}` : sql`sum(amount) DESC, ${key}`}`
}

/** The totals and the groups of one range, both summed by the database over the same filter. */
export async function summaryRows(
  sql: Sql,
  accountId: number,
  f: QueryFilter,
  by: GroupBy,
): Promise<SummaryRows> {
  return {
    totals: await queryTotals(sql, accountId, f),
    groups: by === 'none' ? [] : await queryGroups(sql, accountId, f, by),
  }
}
