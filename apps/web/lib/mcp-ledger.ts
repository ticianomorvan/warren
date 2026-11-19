import type { McpServer } from '@modelcontextprotocol/server'
import { errorTag, formatMoney, formatSignedMoney } from '@warren/core'
import {
  asUser,
  type Database,
  listMovements,
  MOVEMENT_TYPES,
  type MovementListItem,
  type MovementTotals,
  summarizeMovements,
} from '@warren/db'
import { z } from 'zod'

const DEFAULT_LIMIT = 50
const MAX_SPAN_DAYS = 366
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The day a yyyy-mm-dd string names, as a UTC epoch day count, or null when it is no real date. */
function epochDay(text: string): number | null {
  const m = DAY.exec(text)
  // Before 2000 is nonsense for a ledger of bank mail, and it keeps a wild range out.
  if (!m || Number(m[1]) < 2000) return null
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return day.toISOString().startsWith(text) ? Math.round(day.getTime() / 86_400_000) : null
}

const KEYSET = /^(\d{4})-(\d{2})-(\d{2})_(\d{1,15})$/

/** The cursor a client sees: `listMovements`' keyset cursor, as base64url. */
export const encodeCursor = (keyset: string): string => Buffer.from(keyset).toString('base64url')

/** The keyset cursor inside an opaque one, or null when it is not exactly one we made. */
export function decodeCursor(cursor: string): string | null {
  if (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  const keyset = Buffer.from(cursor, 'base64url').toString('utf8')
  const match = KEYSET.exec(keyset)
  if (!match || encodeCursor(keyset) !== cursor) return null
  const [, y, m, d] = match
  return epochDay(`${y}-${m}-${d}`) === null ? null : keyset
}

const movementSchema = z.looseObject({
  id: z.string().describe('Stable id of the movement.'),
  date: z.string().describe('yyyy-mm-dd, in Argentina.'),
  time: z.string().nullable().describe('hh:mm:ss when the bank said it, else null.'),
  type: z.enum(MOVEMENT_TYPES),
  direction: z.enum(['in', 'out']).describe('"in" is money received, "out" money spent.'),
  amount: z.string().describe('Decimal string, always positive; the direction gives the sign.'),
  currency: z.string(),
  display: z.string().describe('The amount as shown to the person, e.g. "$ 1.500,00".'),
  counterparty: z.string().nullable().describe('The merchant, or the other party of a transfer.'),
  account: z.string().nullable().describe("The person's account the money left or entered."),
  counter_account: z.string().nullable().describe("The person's other account in an own transfer."),
  card_last_four: z.string().nullable(),
})

const outputSchema = z.looseObject({
  movements: z.array(movementSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as `cursor` for the next page; null at the end.'),
  as_of: z.string().describe('ISO timestamp of when this was read.'),
})

/** Field by field, never a spread: a column added to the row later must not leave by accident. */
const present = (m: MovementListItem) => ({
  id: m.id,
  date: m.date,
  time: m.time,
  type: m.type,
  direction: m.direction,
  amount: m.amount,
  currency: m.currency,
  display: formatMoney(m.amount, m.currency),
  counterparty: m.counterpartyName,
  account: m.accountName,
  counter_account: m.counterAccountName,
  card_last_four: m.cardLastFour,
})

const fail = (text: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text }],
})

/** Why a range is not acceptable, or null when it is. Days counted with both ends included. */
export function rangeError(from: string, to: string): string | null {
  const a = epochDay(from)
  const b = epochDay(to)
  if (a === null || b === null) return 'Dates must be real days written yyyy-mm-dd.'
  if (a > b) return '`from` must not be after `to`.'
  if (b - a + 1 > MAX_SPAN_DAYS) return `The range must span at most ${MAX_SPAN_DAYS} days.`
  return null
}

/** An exact amount and how the person sees it; a net, which can be negative, uses `formatSignedMoney`. */
const money = (amount: string, currency: string) => ({
  amount,
  display: formatMoney(amount, currency),
})

const moneySchema = z.looseObject({
  amount: z.string().describe('Decimal string, exact; negative only for a net.'),
  display: z.string().describe('The amount as shown to the person, e.g. "$ 1.500,00".'),
})

const totalsFields = {
  count: z.number().int().describe('How many movements are in this group.'),
  in: moneySchema.describe('Money received.'),
  out: moneySchema.describe('Money spent.'),
  net: moneySchema.describe('Received minus spent; negative when more was spent.'),
}

const summaryOutputSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  currencies: z
    .array(
      z.looseObject({
        currency: z.string(),
        ...totalsFields,
        by_type: z.array(z.looseObject({ type: z.enum(MOVEMENT_TYPES), ...totalsFields })),
        by_account: z.array(
          z.looseObject({
            account: z.string().nullable().describe('Name of the account, or null if unknown.'),
            ...totalsFields,
          }),
        ),
      }),
    )
    .describe('One entry per currency that has movements in the range, not own transfers.'),
  own_transfers: z
    .array(
      z.looseObject({
        currency: z.string(),
        count: z.number().int(),
        in: moneySchema,
        out: moneySchema,
      }),
    )
    .describe(
      "Transfers to an account registered as the person's own. They are not spending or income.",
    ),
  as_of: z.string().describe('ISO timestamp of when this was read.'),
})

/** Field by field, with each amount shown the way the person sees it. */
const presentTotals = (t: MovementTotals, currency: string) => ({
  count: t.count,
  in: money(t.in, currency),
  out: money(t.out, currency),
  net: { amount: t.net, display: formatSignedMoney(t.net, currency) },
})

/**
 * `ledger_list_movements` and `ledger_summarize`. `userId` comes from the verified token (set in `authInfo.extra` by
 * the route), never from the arguments. The output is never logged.
 */
export function registerLedgerTools(
  server: McpServer,
  { database, userId, now }: { database: Database; userId: string; now: () => Date },
) {
  server.registerTool(
    'ledger_list_movements',
    {
      title: 'List ledger movements',
      description:
        "Lists the user's ledger movements, newest first: card purchases and transfers, " +
        'each with its date, direction ("in" or "out"), amount and currency, counterparty and ' +
        'account. Amounts are exact decimal strings computed by the program; quote them as ' +
        'given and never add, convert or round them. Returns one page (`limit`, default 50, ' +
        'at most 200); when `next_cursor` is not null, call again with it as `cursor` for ' +
        'older movements. Free-text details of a movement are not available.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
        cursor: z.string().optional().describe('The `next_cursor` of the previous page.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ limit, cursor }) => {
      let keyset: string | null = null
      if (cursor !== undefined) {
        keyset = decodeCursor(cursor)
        if (!keyset) return fail('Invalid cursor. Use the `next_cursor` of a previous result.')
      }
      try {
        const page = await asUser(database, userId, (scope) => listMovements(scope, keyset, limit))
        const output = {
          movements: page.items.map(present),
          next_cursor: page.next ? encodeCursor(page.next) : null,
          as_of: now().toISOString(),
        }
        return {
          structuredContent: output,
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        }
      } catch (error) {
        console.error('mcp ledger_list_movements failed:', errorTag(error))
        return fail('The ledger could not be read. Try again later.')
      }
    },
  )
  server.registerTool(
    'ledger_summarize',
    {
      title: 'Summarize ledger movements',
      description:
        "Returns the user's totals for movements dated from `from` to `to`, both included " +
        '(yyyy-mm-dd, at most 366 days): for each currency, the money received (`in`), spent ' +
        '(`out`) and the net, by movement type and by account, with the number of movements. ' +
        "Transfers to an account registered as the user's own are returned separately in " +
        '`own_transfers` and are not part of the totals. Every total is an exact decimal ' +
        'string computed by the program, with a `display` form; quote them as given and ' +
        'never add, convert or round them.',
      inputSchema: z.object({
        from: z.string().regex(DAY).describe('First day, yyyy-mm-dd.'),
        to: z.string().regex(DAY).describe('Last day, yyyy-mm-dd, not before `from`.'),
      }),
      outputSchema: summaryOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ from, to }) => {
      const problem = rangeError(from, to)
      if (problem) return fail(`Invalid range. ${problem}`)
      try {
        const s = await asUser(database, userId, (scope) => summarizeMovements(scope, { from, to }))
        const output = {
          from,
          to,
          currencies: s.currencies.map((c) => ({
            currency: c.currency,
            ...presentTotals(c, c.currency),
            by_type: c.by_type.map((r) => ({ type: r.type, ...presentTotals(r, c.currency) })),
            by_account: c.by_account.map((r) => ({
              account: r.account,
              ...presentTotals(r, c.currency),
            })),
          })),
          own_transfers: s.own_transfers.map((o) => ({
            currency: o.currency,
            count: o.count,
            in: money(o.in, o.currency),
            out: money(o.out, o.currency),
          })),
          as_of: now().toISOString(),
        }
        return {
          structuredContent: output,
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        }
      } catch (error) {
        console.error('mcp ledger_summarize failed:', errorTag(error))
        return fail('The ledger could not be read. Try again later.')
      }
    },
  )
}
