import { type McpServer, requireScopes } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { checkInput } from '../agent/calls'
import { CATEGORIES, FACT_KINDS, MAX_MOVEMENTS } from '../agent/schema'
import type { WriteCall } from '../apply'
import { argentinaToday } from '../time'
import { UNDO_WINDOW_HOURS } from '../undo'
import {
  done,
  fail,
  MAX_AMOUNT,
  MAX_DAY,
  MAX_TEXT,
  outputSchemas,
  presentMovement,
  QUOTE,
  type ToolContext,
  unavailable,
} from './tools'
import { writeAsMcp } from './write'

/** The scope the six write tools need (a token holds it with `ledger:read`; consent grants every scope asked for). */
export const WRITE_SCOPE = 'ledger:write'

const OUTPUTS = outputSchemas(false)

const requestId = z
  .uuid()
  .optional()
  .describe(
    'A uuid you make up for this call. Send the same call again with the same request_id (a retry after a timeout) and Warren returns the first answer without writing twice.',
  )

const WRITES =
  'Writes the same ledger and memory WhatsApp uses, through the same checks, and the person can undo it from WhatsApp ("deshacer"). ' +
  'Nothing is ever overwritten: a correction adds a new version, a delete only marks the movement. ' +
  'The result carries `record`, what changed as Warren writes it (Spanish), the `batch` it belongs to and how to take it back. ' +
  QUOTE

const amount = z
  .string()
  .max(MAX_AMOUNT)
  .describe(
    'Positive decimal string with at most 2 decimals, e.g. "3500" or "1500.50": no thousands separators, no currency symbol.',
  )
const day = z
  .string()
  .max(MAX_DAY)
  .describe('A real day, yyyy-mm-dd, Argentine time, not after today.')
const text = (what: string) => z.string().max(MAX_TEXT).describe(what)
const direction = z.enum(['in', 'out']).describe('"out" for spending, "in" for income.')
const currency = z.enum(['ARS', 'USD'])
const category = z
  .enum(CATEGORIES)
  .describe(
    'The closest category; "otros" for spending, "otros_ingresos" for income when none fits.',
  )

const newMovement = z.object({
  direction,
  amount,
  currency,
  date: day,
  description: text(
    'What it was, in a few words, e.g. "café" or "nafta YPF". No numbers of 4 or more digits.',
  ),
  category,
  payment: z
    .string()
    .max(MAX_TEXT)
    .nullable()
    .default(null)
    .describe('How it was paid, e.g. "crédito visa" or "efectivo"; null when unknown.'),
})

const changes = z
  .object({
    direction: direction.optional(),
    amount: amount.optional(),
    currency: currency.optional(),
    date: day.optional(),
    description: text('The new description.').optional(),
    category: category.optional(),
    payment: text('The new payment method.').optional(),
  })
  .describe('Only the fields to change; leave the rest out.')

const movementId = z
  .number()
  .int()
  .positive()
  .describe(
    'The id of a live movement of this person, from warren_find_movements or an earlier result.',
  )

const WRITING = { readOnlyHint: false, idempotentHint: false, openWorldHint: false } as const

type Name = WriteCall['tool']

/**
 * The six write tools of slice 5.3. Their inputs are the agent's own value guards (`checkInput`); what is owned by the person
 * and still live is checked under a row lock in `applyCall`. `ledger:write` is each tool's (`scopeChallenge`: a 403
 * `insufficient_scope` with the challenge). `accountId` is the door's. Not offered: forgetting everything, which needs the
 * person's own "sí" on WhatsApp.
 */
export function registerWriteTools(server: McpServer, c: ToolContext) {
  async function run(name: Name, input: unknown, request: string | undefined) {
    const today = argentinaToday(c.now())
    const checked = checkInput(name, input, today)
    if (checked.kind === 'rejected') return fail(checked.message)
    if (checked.kind !== 'action') return fail('invalid input')
    // A secret in a fact is refused with the line the person would be told: nothing is kept.
    if (checked.action.tool === 'notice') return fail(checked.action.input.text)
    try {
      const written = await writeAsMcp(
        {
          sql: c.sql,
          accountId: c.accountId,
          waId: c.waId,
          today,
          requestId: request,
          call: checked.action as WriteCall,
        },
        presentMovement,
      )
      return written.ok
        ? done({ ...written.output, replayed: written.replayed })
        : fail(written.reason)
    } catch (error) {
      return unavailable(`warren_${name}`, error)
    }
  }

  server.registerTool(
    'warren_log_movements',
    {
      title: 'Log movements',
      description:
        `Logs up to ${MAX_MOVEMENTS} movements (spending or income) for the person, each with a direction, amount, currency, day, ` +
        'description, category and payment. Use it when they tell you about something they spent or received. ' +
        WRITES,
      inputSchema: z.object({
        movements: z.array(newMovement).min(1).max(MAX_MOVEMENTS),
        request_id: requestId,
      }),
      outputSchema: OUTPUTS.log,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: { title: 'Log movements', destructiveHint: false, ...WRITING },
    },
    ({ movements, request_id }) =>
      run(
        'log_movements',
        { movements: movements.map((m) => ({ ...m, confidence: 'high' })), text: null },
        request_id,
      ),
  )

  server.registerTool(
    'warren_correct_movement',
    {
      title: 'Correct a movement',
      description:
        'Corrects fields of one live movement (amount, date, description, category, payment...). The old version is kept and ' +
        "marked replaced. Refuses a movement that is not the person's or was already corrected or deleted: look it up again " +
        'with warren_find_movements. ' +
        WRITES,
      inputSchema: z.object({ id: movementId, changes, request_id: requestId }),
      outputSchema: OUTPUTS.correct,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: { title: 'Correct a movement', destructiveHint: true, ...WRITING },
    },
    ({ id, changes: what, request_id }) =>
      run('correct_movement', { id, changes: what, text: null }, request_id),
  )

  server.registerTool(
    'warren_delete_movement',
    {
      title: 'Delete a movement',
      description:
        'Deletes one live movement: it stops counting in totals and lists, and stays recorded (it can be brought back with ' +
        "warren_undo_last). Refuses a movement that is not the person's or was already corrected or deleted. " +
        WRITES,
      inputSchema: z.object({ id: movementId, request_id: requestId }),
      outputSchema: OUTPUTS.deleted,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: { title: 'Delete a movement', destructiveHint: true, ...WRITING },
    },
    ({ id, request_id }) => run('delete_movement', { id, text: null }, request_id),
  )

  server.registerTool(
    'warren_undo_last',
    {
      title: 'Undo the last change',
      description:
        'Takes back the newest change of the person, whichever channel made it (this connection or WhatsApp): everything one ' +
        `request logged, corrected, deleted, remembered or forgot, as one step, within ${UNDO_WINDOW_HOURS} hours. Refuses when something it ` +
        'touched was changed since, and says what. Calling it again takes back the one before. ' +
        WRITES,
      inputSchema: z.object({ request_id: requestId }),
      outputSchema: OUTPUTS.undone,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: { title: 'Undo the last change', destructiveHint: true, ...WRITING },
    },
    ({ request_id }) => run('undo_last', { text: null }, request_id),
  )

  server.registerTool(
    'warren_remember_fact',
    {
      title: 'Remember something about the person',
      description:
        "Stores one thing Warren should remember, in the person's own words: an alias (a name for a payment method, a place or a " +
        'thing: key "la visa", value "Galicia"), a category rule (key "café", value one of the categories) or a note. A new value ' +
        'for the same kind and key replaces the old one. Refuses secrets (card or account numbers, passwords, ID numbers) and ' +
        'contact data. Only remember what the person said. ' +
        WRITES,
      inputSchema: z.object({
        kind: z.enum(FACT_KINDS).describe('"alias", "category" or "note".'),
        key: text('1 to 4 short words (at most 40 characters).'),
        value: text('At most 100 characters; for a category fact exactly one category.'),
        request_id: requestId,
      }),
      outputSchema: OUTPUTS.remembered,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: {
        title: 'Remember something about the person',
        destructiveHint: false,
        ...WRITING,
      },
    },
    ({ kind, key, value, request_id }) =>
      run('remember_fact', { kind, key, value, text: null }, request_id),
  )

  server.registerTool(
    'warren_forget_fact',
    {
      title: 'Forget one thing',
      description:
        'Forgets one remembered fact, by its id (from warren_list_facts) or by its key. It stays recorded and can be brought back ' +
        'with warren_undo_last. Forgetting everything is not offered here: the person does it themselves on WhatsApp. ' +
        WRITES,
      inputSchema: z.object({
        id: z.number().int().positive().optional().describe('The id of the fact.'),
        key: text('Its key, when you have no id.').optional(),
        request_id: requestId,
      }),
      outputSchema: OUTPUTS.forgotten,
      scopeChallenge: requireScopes(WRITE_SCOPE),
      annotations: { title: 'Forget one thing', destructiveHint: true, ...WRITING },
    },
    ({ id, key, request_id }) =>
      run('forget_fact', { id: id ?? 0, key: key ?? '', text: null }, request_id),
  )
}
