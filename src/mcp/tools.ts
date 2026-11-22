import { type McpServer, requireScopes } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { checkInput } from '../agent/calls'
import {
  CATEGORIES,
  FACT_KINDS,
  type GROUPS,
  isTimeGroup,
  PERIODS,
  RangeSchema,
  TOOL_INPUTS,
} from '../agent/schema'
import type { Sql } from '../db'
import { allLiveFacts } from '../facts'
import { findMovements, type GroupTotal, type MovementRow, type QueryTotal } from '../ledger'
import { log } from '../log'
import { formatMoney } from '../render'
import { groupLabel, MAX_BUCKETS, rangeLabel, type Side } from '../render-summary'
import { runSummary } from '../run-summary'
import { change, formatPercent } from '../summary'
import { argentinaToday } from '../time'

/** The scope each kind of tool needs (`src/auth/config.ts` has the full list). */
export const READ_SCOPE = 'ledger:read'

/** The longest a free-text input may be (a word or two is what they hold), a day, an amount: a client cannot send a book. */
export const MAX_TEXT = 200
export const MAX_DAY = 20
export const MAX_AMOUNT = 20

/** A page of `warren_find_movements`: 25 rows are about 3k tokens, far under what a client takes in one result. */
export const DEFAULT_PAGE = 25
export const MAX_PAGE = 50
/**
 * Groups listed per direction and currency in `warren_summarize`'s structured result, for a grouping that is not by time (the
 * biggest first, as the database orders them); a grouping by day, week or month keeps the latest `MAX_BUCKETS`, as the text does.
 */
export const MAX_GROUPS_LISTED = 100

/** Closed (`strict`) for the test that holds the real output to it; open in production, so a field added later breaks no client. */
export function outputSchemas(strict: boolean) {
  const obj = strict ? z.strictObject : z.looseObject
  const money = {
    amount: z.string().describe('Decimal string, exact. Quote it as given.'),
    display: z.string().describe('The amount as Warren shows it, e.g. "$3.500" or "US$ 20".'),
  }
  const movement = obj({
    id: z.number().int().describe('Warren id of the movement.'),
    date: z.string().describe('yyyy-mm-dd, Argentine day.'),
    time: z.string().describe('hh:mm Argentine time when it was logged.'),
    direction: z.enum(['in', 'out']).describe('"out" is money spent, "in" money received.'),
    ...money,
    currency: z.enum(['ARS', 'USD']),
    description: z.string(),
    category: z.enum(CATEGORIES),
    payment: z.string().nullable(),
  })
  const total = obj({
    direction: z.enum(['in', 'out']),
    currency: z.enum(['ARS', 'USD']),
    count: z.number().int(),
    ...money,
  })
  const group = obj({
    key: z.string(),
    label: z.string().describe('The group in words, as Warren says it.'),
    direction: z.enum(['in', 'out']),
    currency: z.enum(['ARS', 'USD']),
    count: z.number().int(),
    ...money,
  })
  const side = obj({
    from: z.string(),
    to: z.string(),
    label: z.string().describe('The range in words, e.g. "Octubre (1–31)".'),
    totals: z.array(total).describe('One per direction and currency; never added together.'),
    groups: z.array(group),
    groups_omitted: z
      .number()
      .int()
      .describe('Groups left out of `groups` (the text lists the rest).'),
  })
  return {
    find: obj({
      movements: z.array(movement),
      next_cursor: z
        .string()
        .nullable()
        .describe('Pass as `cursor` for the next page; null at the end.'),
    }),
    summarize: obj({
      ...side.shape,
      compared_with: side.nullable(),
      changes: z
        .array(
          obj({
            direction: z.enum(['in', 'out']),
            currency: z.enum(['ARS', 'USD']),
            way: z
              .enum(['more', 'less', 'same'])
              .describe('How the asked range went from the compared one.'),
            ...money,
            percent: z
              .string()
              .nullable()
              .describe('"+20,5%", or null when there was nothing before.'),
          }),
        )
        .describe('Empty unless the summary was compared.'),
      summary: z.string().describe('The same summary as Warren writes it on WhatsApp, in Spanish.'),
    }),
    ...writeOutputs(obj, movement, money),
    facts: obj({
      facts: z.array(
        obj({
          id: z.number().int(),
          kind: z.enum(FACT_KINDS),
          key: z.string(),
          value: z.string(),
        }),
      ),
      total: z.number().int(),
    }),
  }
}

/** What every change returns: its batch (null when nothing was written), the record Warren renders and how to take it back. */
const writeBase = (_obj: typeof z.looseObject) => ({
  batch: z
    .number()
    .int()
    .nullable()
    .describe('The batch this change belongs to; null when nothing was written.'),
  record: z.string().describe('What changed, as Warren writes it on WhatsApp (Spanish).'),
  undo: z
    .string()
    .nullable()
    .describe('How to take the change back; null when nothing was written.'),
})

function writeOutputs(
  obj: typeof z.looseObject,
  movement: ReturnType<typeof z.looseObject>,
  _money: Record<string, unknown>,
) {
  const base = writeBase(obj)
  const factView = obj({
    id: z.number().int(),
    kind: z.enum(FACT_KINDS),
    key: z.string(),
    value: z.string(),
  })
  return {
    log: obj({ ...base, movements: z.array(movement) }),
    correct: obj({
      ...base,
      changed: z
        .array(z.string())
        .describe('The fields the correction changed; empty when it was already so.'),
      before: movement,
      after: movement,
    }),
    deleted: obj({ ...base, deleted: movement }),
    undone: obj({
      ...base,
      undone_batch: z.number().int(),
      items: z.array(
        obj({
          kind: z.enum([
            'logged',
            'corrected',
            'deleted',
            'fact_removed',
            'fact_restored',
            'fact_reverted',
          ]),
          movement: movement.optional(),
          from: movement.optional(),
          fact: factView.optional(),
          was: z.string().optional(),
        }),
      ),
    }),
    remembered: obj({
      ...base,
      status: z.enum(['new', 'updated', 'unchanged']),
      fact: factView,
      previous_value: z.string().nullable(),
    }),
    forgotten: obj({ ...base, forgotten: z.array(factView) }),
  }
}

const OUTPUTS = outputSchemas(false)

export const fail = (text: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text }],
})

export const done = <T extends Record<string, unknown>>(output: T) => ({
  structuredContent: output,
  content: [{ type: 'text' as const, text: JSON.stringify(output) }],
})

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export const QUOTE =
  'Every amount is computed by Warren from the ledger: quote the amounts and totals as given (use `display` ' +
  'when showing money) and never add, subtract, convert or round them yourself.'

// ---- The cursor of a page: the id the next page starts below, opaque to the client.

export const encodeCursor = (beforeId: number): string =>
  Buffer.from(`m${beforeId}`).toString('base64url')

/** The id inside a cursor we made, or null for anything else. */
export function decodeCursor(cursor: string): number | null {
  if (cursor.length > 32 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const id = /^m([1-9]\d{0,14})$/.exec(text)?.[1]
  return id !== undefined && encodeCursor(Number(id)) === cursor ? Number(id) : null
}

// ---- What each tool shows.

export const presentMovement = (m: MovementRow) => ({
  id: m.id,
  date: m.date,
  time: m.time ?? '',
  direction: m.direction,
  amount: m.amount,
  display: formatMoney(m.amount, m.currency),
  currency: m.currency,
  description: m.description,
  category: m.category,
  payment: m.payment,
})

const presentTotal = (t: QueryTotal) => ({
  direction: t.direction,
  currency: t.currency,
  count: t.count,
  amount: t.total,
  display: formatMoney(t.total, t.currency),
})

/**
 * The groups of a range that are listed, and how many are left out. Each direction and currency has its own: one with many
 * groups never crowds another out. By time the latest buckets are kept (what `renderSummary` shows); otherwise the biggest.
 */
export function listGroups(groups: GroupTotal[], by: (typeof GROUPS)[number]) {
  const perPair = new Map<string, GroupTotal[]>()
  for (const g of groups) {
    const pair = `${g.direction}:${g.currency}`
    perPair.set(pair, [...(perPair.get(pair) ?? []), g])
  }
  const listed: GroupTotal[] = []
  for (const all of perPair.values()) {
    listed.push(
      ...(isTimeGroup(by)
        ? all.slice(-MAX_BUCKETS) // oldest first: the latest are the last
        : all.slice(0, MAX_GROUPS_LISTED)),
    )
  }
  return { listed, omitted: groups.length - listed.length }
}

const presentSide = (s: Side, by: (typeof GROUPS)[number], today: string) => {
  const { listed, omitted } = listGroups(s.groups, by)
  return {
    from: s.range.from,
    to: s.range.to,
    label: rangeLabel(s.range, today),
    totals: s.totals.map(presentTotal),
    groups: listed.map((g: GroupTotal) => ({
      key: g.key,
      label: groupLabel(by, g, today),
      ...presentTotal(g),
    })),
    groups_omitted: omitted,
  }
}

/** How the asked range went from the compared one, per direction and currency, from `summary.ts` (exact, in cents). */
function changes(now: Side, before: Side) {
  const pairs = new Map<string, { direction: 'in' | 'out'; currency: 'ARS' | 'USD' }>()
  for (const t of [...now.totals, ...before.totals]) {
    pairs.set(`${t.direction}:${t.currency}`, { direction: t.direction, currency: t.currency })
  }
  const total = (side: Side, p: { direction: string; currency: string }) =>
    side.totals.find((t) => t.direction === p.direction && t.currency === p.currency)?.total ?? '0'
  return [...pairs.values()].map((p) => {
    const c = change(total(now, p), total(before, p))
    return {
      ...p,
      way: c.way,
      amount: c.amount,
      display: formatMoney(c.amount, p.currency),
      percent: c.tenths === null ? null : formatPercent(c.tenths),
    }
  })
}

// ---- The tools' inputs: the agent's own schemas (`TOOL_INPUTS`), without what is WhatsApp's (`text`), with words a client reads.

const findBase = TOOL_INPUTS.find_movements()
const findInput = findBase.omit({ limit: true }).extend({
  text: z
    .string()
    .max(MAX_TEXT)
    .optional()
    .describe(
      'Words of the description or the category, all of them must match (accents and case ignored), e.g. "café" or "nafta ypf".',
    ),
  from: z.string().max(MAX_DAY).optional().describe('First day, yyyy-mm-dd (inclusive).'),
  to: z.string().max(MAX_DAY).optional().describe('Last day, yyyy-mm-dd (inclusive).'),
  category: findBase.shape.category.describe('Only this category.'),
  payment: z
    .string()
    .max(MAX_TEXT)
    .optional()
    .describe('Part of how it was paid, e.g. "visa" or "efectivo" (accents and case ignored).'),
  amount: z
    .string()
    .max(MAX_AMOUNT)
    .optional()
    .describe('Exactly this amount, a decimal string such as "3500" or "1500.50".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE)
    .default(DEFAULT_PAGE)
    .describe(`Page size, 1 to ${MAX_PAGE}.`),
  cursor: z.string().max(32).optional().describe('The `next_cursor` of the previous page.'),
})

const rangeBase = RangeSchema()
const summarizeBase = TOOL_INPUTS.summarize()
const summarizeInput = summarizeBase.omit({ text: true }).extend({
  range: rangeBase
    .extend({
      period: rangeBase.shape.period.describe(
        `${PERIODS.join(', ')}. Use month, year or dates with the fields below; a field a period does not use stays 0 or "". Weeks run Monday to Sunday; a period that is not over ends today.`,
      ),
      month: rangeBase.shape.month.describe('period "month": the month number, 1 to 12.'),
      year: rangeBase.shape.year.describe(
        'period "month" (0 = the latest such month not in the future) or "year": the year.',
      ),
      from: z
        .string()
        .max(MAX_DAY)
        .default('')
        .describe('period "dates": yyyy-mm-dd, mm-dd or dd.'),
      to: z
        .string()
        .max(MAX_DAY)
        .default('')
        .describe('period "dates": same forms; "" is the same day as `from`.'),
    })
    .describe('The days to total, in Argentine days.'),
  group_by: summarizeBase.shape.group_by.describe(
    'Split the totals by category, payment (how it was paid), day, week or month; "none" for the totals only. A comparison cannot be grouped by day, week or month.',
  ),
  compare_to: summarizeBase.shape.compare_to.describe(
    '"previous" compares with the range just before (cut to the same stretch while the period is running), "range" with the range in `other`, "none" does not compare.',
  ),
  other: z
    .string()
    .max(MAX_TEXT)
    .default('')
    .describe(
      'Only with compare_to "range": the second range as text, e.g. "last_month", "month:10", "month:10:2025", "year:2025" or "dates:11-01..11-15".',
    ),
  direction: summarizeBase.shape.direction.describe(
    '"out" for spending, "in" for income, null for both.',
  ),
  category: summarizeBase.shape.category.describe('Only this category, or null.'),
  payment: z
    .string()
    .max(MAX_TEXT)
    .nullable()
    .default(null)
    .describe('Part of how it was paid (e.g. "visa"), or null.'),
  description: z
    .string()
    .max(MAX_TEXT)
    .nullable()
    .default(null)
    .describe(
      'Words of the description to total or count, e.g. "café" for "how many coffees"; no digits. Null for all.',
    ),
})

export interface ToolContext {
  sql: Sql
  /** The person: from the verified token, never from an argument. */
  accountId: number
  /** Their WhatsApp id: a write's batch carries it, so an undo from WhatsApp finds it. */
  waId: string
  now: () => Date
}

/** One failed read, told to the client without detail and to the log without data. */
export function unavailable(tool: string, error: unknown) {
  log('mcp_tool_failed', { tool, error: error instanceof Error ? error.name : 'unknown' }, 'error')
  return fail('Warren could not read your data right now. Try again in a moment.')
}

/**
 * The three read tools of slice 5.2. `accountId` is the door's, so a tool can only ever read the caller's own rows; every
 * query takes it. Nothing returned is logged.
 */
export function registerReadTools(server: McpServer, c: ToolContext) {
  server.registerTool(
    'warren_find_movements',
    {
      title: 'Find movements',
      description:
        "Lists the person's movements (spending and income logged in Warren), newest first, optionally filtered by words, " +
        'dates, category, payment or exact amount. Each has an id, date, time, direction ("out" spent, "in" received), ' +
        'amount, currency, description, category and payment. Returns one page (`limit`, default ' +
        `${DEFAULT_PAGE}, at most ${MAX_PAGE}); when \`next_cursor\` is not null, call again with it as \`cursor\` for older ones. ` +
        'Use warren_summarize for totals instead of adding movements up. Corrected or deleted movements are not listed. ' +
        QUOTE,
      inputSchema: findInput,
      outputSchema: OUTPUTS.find,
      scopeChallenge: requireScopes(READ_SCOPE),
      annotations: { title: 'Find movements', ...READ_ONLY },
    },
    async (input) => {
      // The agent's own value guards, on the filter alone: a page's size and cursor are this tool's, not the agent's.
      const { limit, cursor, ...filter } = input
      const checked = checkInput('find_movements', filter, argentinaToday(c.now()))
      if (checked.kind !== 'read') {
        return fail(checked.kind === 'rejected' ? checked.message : 'invalid input')
      }
      let beforeId: number | undefined
      if (cursor !== undefined) {
        const id = decodeCursor(cursor)
        if (id === null) return fail('Invalid cursor. Use the `next_cursor` of a previous result.')
        beforeId = id
      }
      try {
        // One more than a page, to know whether there is a next one.
        const rows = await findMovements(
          c.sql,
          c.accountId,
          { ...checked.filter, limit: limit + 1 },
          beforeId ? { beforeId } : {},
        )
        const page = rows.slice(0, limit)
        const last = page.at(-1)
        return done({
          movements: page.map(presentMovement),
          next_cursor: rows.length > limit && last ? encodeCursor(last.id) : null,
        })
      } catch (error) {
        return unavailable('warren_find_movements', error)
      }
    },
  )

  server.registerTool(
    'warren_summarize',
    {
      title: 'Summarize spending and income',
      description:
        'Totals of the ledger over a range of Argentine days (a named period such as this_month or last_week, a month, a year ' +
        'or explicit dates), optionally filtered by direction, category, payment or description words, grouped (by category, ' +
        'payment, day, week or month) and compared with the previous range or another one. Totals are per direction ("out" ' +
        'spent, "in" received) and currency, never mixed. Also returns the same summary as Warren writes it on WhatsApp, in ' +
        'Spanish, in `summary`. Use this for any question about how much, how many or how it changed. ' +
        QUOTE,
      inputSchema: summarizeInput,
      outputSchema: OUTPUTS.summarize,
      scopeChallenge: requireScopes(READ_SCOPE),
      annotations: { title: 'Summarize spending and income', ...READ_ONLY },
    },
    async (input) => {
      const today = argentinaToday(c.now())
      // The agent's own value guards, with the `text` field that is WhatsApp's left empty.
      const q = { ...input, text: null }
      const checked = checkInput('summarize', q, today)
      if (checked.kind === 'rejected') return fail(checked.message)
      if (checked.kind !== 'action' || checked.action.tool !== 'summarize') {
        return fail('invalid input')
      }
      try {
        // One snapshot for the asked range and the compared one.
        const ran = await c.sql.begin('isolation level repeatable read read only', (tx) =>
          runSummary(tx as unknown as Sql, c.accountId, checked.action.input as typeof q, today),
        )
        return done({
          ...presentSide(ran.current, q.group_by, today),
          compared_with: ran.previous ? presentSide(ran.previous, q.group_by, today) : null,
          changes: ran.previous ? changes(ran.current, ran.previous) : [],
          summary: ran.lines.join('\n'),
        })
      } catch (error) {
        return unavailable('warren_summarize', error)
      }
    },
  )

  server.registerTool(
    'warren_list_facts',
    {
      title: 'List what Warren remembers',
      description:
        'Lists everything Warren remembers about the person, in their own words: aliases (a name for a payment method, place or ' +
        'thing, e.g. "la visa" = "Galicia"), category rules (where a kind of expense goes) and notes. Each has an id, kind ' +
        '("alias", "category" or "note"), key and value. Read-only; these never change a movement.',
      inputSchema: z.object({}),
      outputSchema: OUTPUTS.facts,
      scopeChallenge: requireScopes(READ_SCOPE),
      annotations: { title: 'List what Warren remembers', ...READ_ONLY },
    },
    async () => {
      try {
        const facts = await allLiveFacts(c.sql, c.accountId)
        return done({
          facts: facts.map((f) => ({ id: f.id, kind: f.kind, key: f.key, value: f.value })),
          total: facts.length,
        })
      } catch (error) {
        return unavailable('warren_list_facts', error)
      }
    },
  )
}
