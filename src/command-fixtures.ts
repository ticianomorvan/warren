import type { Changes, Command, Movement } from './parse'
import {
  movement as base,
  bodies,
  fakeModel,
  messageBody,
  post,
  row,
  type setup,
  sql,
  until,
} from './test-harness'

/** Fixtures for the command tests: scripted models, seeded movements, one message in and its reply out. */
export const WA = '5491100000000'
/** The harness café, with no payment unless a test gives one. */
export const movement = (o: Partial<Movement> = {}) => base({ payment: null, ...o })
export const NONE: Changes = {
  direction: null,
  amount: null,
  currency: null,
  date: null,
  description: null,
  category: null,
  payment: null,
}
export const logOf = (...movements: Movement[]): Command => ({ type: 'log', movements })
export const correct = (
  o: { target?: string; index?: number | null; changes?: Partial<Changes>; low?: boolean } = {},
): Command => ({
  type: 'correct',
  target: o.target ?? 'last',
  target_index: o.index === undefined ? 1 : o.index,
  changes: { ...NONE, ...o.changes },
  confidence: o.low ? 'low' : 'high',
})
export const remove = (target = 'last', index: number | null = 1): Command => ({
  type: 'delete',
  target,
  target_index: index,
  confidence: 'high',
})
export const ask = (
  period: Extract<Command, { type: 'query' }>['period'],
  o: Partial<Extract<Command, { type: 'query' }>> = {},
): Command => ({ type: 'query', period, direction: 'out', category: null, payment: null, ...o })

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

/** A model that answers each call with the next command. */
export const script = (...commands: Command[]) => {
  let i = 0
  return fakeModel(() => commands[i++] as Command)
}

export type Seed = {
  on: string
  amount: string
  currency?: Movement['currency']
  direction?: Movement['direction']
  category?: Movement['category']
  payment?: string | null
  description?: string
}
let seeds = 0
/** Stores movements straight in the table, as if earlier messages had logged them. */
export async function seed(rows: Seed[]): Promise<void> {
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
  }))
  await sql`INSERT INTO movement ${sql(values)}`
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
