import type { McpServer } from '@modelcontextprotocol/server'
import {
  argentinaMinute,
  errorTag,
  formatMoney,
  PROFILE_CURRENCIES,
  type Profile,
} from '@warren/core'
import { asUser, type Database, latestProfile } from '@warren/db'
import { z } from 'zod'

const currency = z.enum(PROFILE_CURRENCIES)

const profileSchema = z.object({
  version: z.number().int().describe('Which save this is; the highest is the latest.'),
  saved_at: z.string().describe('ISO timestamp (UTC) of when the person saved it.'),
  saved_at_local: z.string().describe('The same moment as "yyyy-mm-dd hh:mm" in Argentina.'),
  monthly_income: z
    .string()
    .optional()
    .describe('Decimal string, in `currency`. Absent when the person left it blank.'),
  monthly_income_display: z
    .string()
    .optional()
    .describe('`monthly_income` as shown to the person, e.g. "US$ 15.000,00".'),
  currency: currency.describe('The currency of `monthly_income`.'),
  goals: z.array(
    z.object({
      name: z.string(),
      target: z.string().describe('Decimal string, in the goal currency.'),
      display: z.string().describe('`target` as shown to the person.'),
      currency,
      date: z.string().describe('yyyy-mm-dd: when the person wants to have it.'),
    }),
  ),
  obligations: z
    .array(
      z.object({
        name: z.string(),
        amount: z.string().describe('Decimal string, per month, in the obligation currency.'),
        display: z.string().describe('`amount` as shown to the person.'),
        currency,
        due_day: z.number().int().optional().describe('Day of the month it is due, 1 to 31.'),
      }),
    )
    .describe('Fixed monthly commitments, such as rent or loan payments.'),
  risk_limits: z.object({
    emergency_months: z
      .number()
      .int()
      .optional()
      .describe('Months of expenses the person wants kept liquid first.'),
    max_share_in_usd: z
      .number()
      .int()
      .optional()
      .describe('The most they accept holding in dollars, as a whole percent of savings.'),
  }),
})

const outputSchema = z.object({
  profile: profileSchema
    .nullable()
    .describe('The latest saved profile, or null when none is saved or the saved one is invalid.'),
  stored_profile_invalid: z
    .boolean()
    .optional()
    .describe(
      'Present and true when the person saved a profile that no longer passes validation, so ' +
        '`profile` is null for that reason. They fix it by saving again on their profile page.',
    ),
})

/** Field by field on top of the validated profile: each amount gets its `display`, as in the ledger tools. */
const present = (version: number, createdAt: string, p: Profile) => ({
  version,
  saved_at: createdAt,
  saved_at_local: argentinaMinute(new Date(createdAt)),
  ...(p.monthly_income === undefined
    ? {}
    : {
        monthly_income: p.monthly_income,
        monthly_income_display: formatMoney(p.monthly_income, p.currency),
      }),
  currency: p.currency,
  goals: p.goals.map((g) => ({
    name: g.name,
    target: g.target,
    display: formatMoney(g.target, g.currency),
    currency: g.currency,
    date: g.date,
  })),
  obligations: p.obligations.map((o) => ({
    name: o.name,
    amount: o.amount,
    display: formatMoney(o.amount, o.currency),
    currency: o.currency,
    ...(o.due_day === undefined ? {} : { due_day: o.due_day }),
  })),
  risk_limits: p.risk_limits,
})

/**
 * `profile_get`, registered only for a token with `profile:read`. `userId` comes from the
 * verified token, never from the arguments. The output is never logged.
 */
export function registerProfileTools(
  server: McpServer,
  { database, userId }: { database: Database; userId: string },
) {
  server.registerTool(
    'profile_get',
    {
      title: 'Get the financial profile',
      description:
        "Returns the user's latest financial profile, as they wrote it on their Warren profile " +
        'page: monthly income, savings goals (name, target amount, currency, target date), ' +
        'monthly obligations (name, amount, currency, due day) and risk limits (months of ' +
        'emergency fund, maximum share held in dollars). Amounts are exact decimal strings, each ' +
        'with a `display` text to show the person; quote them as given and never add, convert or ' +
        'round them. The save time comes in UTC and in Argentina time (`saved_at_local`). Returns `{ "profile": null }` when ' +
        'the user has not saved one, and also `"stored_profile_invalid": true` when the saved ' +
        'one no longer passes validation.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const stored = await asUser(database, userId, latestProfile)
        // `latestProfile` returns only what `parseProfile` keeps, so no stray field can pass.
        const output = stored?.profile
          ? { profile: present(stored.version, stored.created_at, stored.profile) }
          : stored
            ? { profile: null, stored_profile_invalid: true }
            : { profile: null }
        return {
          structuredContent: output,
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        }
      } catch (error) {
        console.error('mcp profile_get failed:', errorTag(error))
        return {
          isError: true as const,
          content: [
            { type: 'text' as const, text: 'The profile could not be read. Try again later.' },
          ],
        }
      }
    },
  )
}
