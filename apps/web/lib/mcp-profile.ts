import type { McpServer } from '@modelcontextprotocol/server'
import { errorTag, PROFILE_CURRENCIES } from '@warren/core'
import { asUser, type Database, latestProfile } from '@warren/db'
import { z } from 'zod'

const currency = z.enum(PROFILE_CURRENCIES)

const profileSchema = z.object({
  version: z.number().int().describe('Which save this is; the highest is the latest.'),
  saved_at: z.string().describe('ISO timestamp of when the person saved it.'),
  monthly_income: z
    .string()
    .optional()
    .describe('Decimal string, in `currency`. Absent when the person left it blank.'),
  currency: currency.describe('The currency of `monthly_income`.'),
  goals: z.array(
    z.object({
      name: z.string(),
      target: z.string().describe('Decimal string, in the goal currency.'),
      currency,
      date: z.string().describe('yyyy-mm-dd: when the person wants to have it.'),
    }),
  ),
  obligations: z
    .array(
      z.object({
        name: z.string(),
        amount: z.string().describe('Decimal string, per month, in the obligation currency.'),
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
        'emergency fund, maximum share held in dollars). Amounts are exact decimal strings; quote ' +
        'them as given and never add, convert or round them. Returns `{ "profile": null }` when ' +
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
          ? {
              profile: {
                version: stored.version,
                saved_at: stored.created_at,
                ...stored.profile,
              },
            }
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
