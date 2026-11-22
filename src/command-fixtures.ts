import type { Changes, Movement } from './agent'
import {
  movement as base,
  bodies,
  fakeModel,
  helpCall,
  logCall,
  messageBody,
  post,
  replyCall,
  row,
  type setup,
  sql,
  TODAY,
  type ToolCall,
  until,
} from './test-harness'

/** Fixtures for the agent tests: scripted models, seeded movements, one message in and its reply out. */
export const WA = '5491100000000'
/** The harness café, with no payment unless a test gives one. */
export const movement = (o: Partial<Movement> = {}) => base({ payment: null, ...o })
export const NONE: Changes = {}
export const logOf = (...movements: Movement[]): ToolCall => logCall(...movements)
export const correct = (id: number, changes: Partial<Changes>): ToolCall => ({
  name: 'correct_movement',
  input: { id, changes: { ...NONE, ...changes }, text: null },
})
export const remove = (id: number): ToolCall => ({
  name: 'delete_movement',
  input: { id, text: null },
})
/** The model takes back the last batch of changes. */
export const undoCall: ToolCall = { name: 'undo_last', input: { text: null } }
/** The same call with the model's own words added. */
export const saying = (call: ToolCall, text: string): ToolCall => ({
  ...call,
  input: { ...(call.input as object), text },
})
/** A range as the model sends it: a named period, or `month`, `year` or `dates` with what they use. */
export const range = (
  period: string,
  o: { month?: number; year?: number; from?: string; to?: string } = {},
) => ({ period, month: 0, year: 0, from: '', to: '', ...o })
export const summarize = (
  period: string,
  o: {
    direction?: 'in' | 'out' | null
    category?: string | null
    payment?: string | null
    description?: string | null
    /** A range that is not a bare period (`month`, `year`, `dates`). */
    range?: ReturnType<typeof range>
    group_by?: string
    compare_to?: 'none' | 'previous' | 'range'
    other?: ReturnType<typeof range>
  } = {},
): ToolCall => ({
  name: 'summarize',
  input: {
    range: range(period),
    group_by: 'none',
    compare_to: 'none',
    direction: 'out',
    category: null,
    payment: null,
    description: null,
    text: null,
    ...o,
  },
})
export const find = (o: Record<string, unknown> = {}): ToolCall => ({
  name: 'find_movements',
  input: o,
})
export const ask = (
  ids: number[],
  o: { question?: string; after?: 'none' | 'correct' | 'delete'; changes?: Partial<Changes> } = {},
): ToolCall => ({
  name: 'ask_user',
  input: {
    question: o.question ?? 'Cuál',
    movement_ids: ids,
    after_answer: o.after ?? 'none',
    ...(o.after === 'correct' ? { changes: o.changes } : {}),
  },
})
export { helpCall, replyCall }

export type App = Awaited<ReturnType<typeof setup>>

let n = 0
export let lastWamid = ''
/** One message in, waits until its reply is out and recorded. Returns that reply. */
export async function say(app: App, o: { at?: string; text?: string } = {}): Promise<string> {
  const wamid = `wamid.CMD${++n}`
  lastWamid = wamid
  const before = app.calls.sent.length
  const extra = {
    ...(o.at ? { timestamp: String(Math.floor(Date.parse(o.at) / 1000)) } : {}),
    ...(o.text ? { text: { body: o.text } } : {}),
  }
  await post(app.base, messageBody(wamid, WA, extra))
  await until(async () => (await row(wamid))?.status === 'done')
  return bodies(app.calls)[before] ?? ''
}

/**
 * A model that sends each given turn as it is, three times in a row: a text the numbers check refuses
 * is sent back for a repair (inside the cap), so a test of what the commit point drops needs a model that
 * insists. A bare call is a turn of one.
 */
export const insist = (...turns: (ToolCall | ToolCall[])[]) =>
  script(...turns.flatMap((t) => [t, t, t]))

/** A model that answers each call with the next turn: a list of tool calls. A bare call is a turn of one. */
export const script = (...turns: (ToolCall | ToolCall[])[]) => {
  let i = 0
  return fakeModel(() => [turns[i++] ?? []].flat())
}

export type Seed = {
  on: string
  amount: string
  currency?: Movement['currency']
  direction?: Movement['direction']
  category?: Movement['category']
  payment?: string | null
  description?: string
  /** When it was logged, Argentine HH:MM on its day. */
  at?: string
}
let seeds = 0
/** Stores movements straight in the table, as if earlier messages had logged them. Returns their ids, in order. */
export async function seed(rows: Seed[]): Promise<number[]> {
  const [account] = await sql`
    INSERT INTO account (wa_id) VALUES (${WA})
    ON CONFLICT (wa_id) DO UPDATE SET wa_id = EXCLUDED.wa_id RETURNING id`
  const [inbound] = await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${`seed.${++seeds}`}, ${WA}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id`
  const values = rows.map((r, position) => ({
    account_id: account?.id,
    inbound_message_id: inbound?.id,
    position,
    direction: r.direction ?? 'out',
    amount: r.amount,
    currency: r.currency ?? 'ARS',
    occurred_on: r.on,
    description: r.description ?? 'algo',
    category: r.category ?? 'otros',
    payment: r.payment ?? null,
    confidence: 'high',
    ...(r.at ? { created_at: new Date(`${r.on}T${r.at}:00-03:00`) } : {}),
  }))
  const inserted = await sql<
    { id: number }[]
  >`INSERT INTO movement ${sql(values)} RETURNING id::int AS id`
  return inserted.map((r) => r.id)
}

export const history = () =>
  sql`SELECT id::int AS id, inbound_message_id::int AS inbound, amount::text AS amount, description,
    superseded_by::int AS superseded_by, deleted_at IS NOT NULL AS deleted, deleted_by::int AS deleted_by
    FROM movement ORDER BY id`
export const sum = async (where: string) =>
  (await sql.unsafe(`SELECT sum(amount)::text AS total FROM movement WHERE ${where}`))[0]?.total

/** The how-to-answer line every question ends with, for a first candidate numbered `n`. */
export const HOW = (n: number) =>
  `\nRespondé con el número, por ejemplo "el ${n} fue 4100" o "borrá el ${n}".`

/** Five movements of today, logged at 09:00, 10:10, 10:45, 11:54 and 11:59; ids 1 to 5, the taxi is the newest. */
export const day = async () =>
  seed([
    {
      on: TODAY,
      amount: '12000',
      description: 'súper',
      category: 'supermercado',
      payment: 'crédito visa',
      at: '09:12',
    },
    { on: TODAY, amount: '3500', description: 'café', category: 'restaurantes', at: '10:10' },
    {
      on: TODAY,
      amount: '20000',
      description: 'nafta',
      category: 'combustible',
      payment: 'efectivo',
      at: '10:45',
    },
    { on: TODAY, amount: '2900', description: 'café', category: 'restaurantes', at: '11:54' },
    { on: TODAY, amount: '5400', description: 'taxi', category: 'transporte', at: '11:59' },
  ])

export const live = async () =>
  (
    await sql`SELECT id::int AS id, description, amount::text AS amount FROM movement
      WHERE superseded_by IS NULL AND deleted_at IS NULL ORDER BY id`
  ).map((r) => `${r.description} ${r.amount}`)
