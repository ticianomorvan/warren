import type { McpServer } from '@modelcontextprotocol/server'
import { errorTag, formatMoney } from '@warren/core'
import {
  asUser,
  type Database,
  listMovements,
  MOVEMENT_TYPES,
  type MovementListItem,
} from '@warren/db'
import { z } from 'zod'

const DEFAULT_LIMIT = 50
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
  const day = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return day.toISOString().startsWith(`${y}-${m}-${d}`) ? keyset : null
}

const movementSchema = z.object({
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

const outputSchema = z.object({
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

/**
 * `ledger_list_movements`. `userId` comes from the verified token (set in `authInfo.extra` by
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
}
