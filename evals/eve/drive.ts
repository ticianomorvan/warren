import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, type ClientSession } from 'eve/client'
import type { Delivery } from 'eve/sessions'
import { FALLBACK_TEXT, finalize } from '../../agent/lib/finalize'
import { estimateCostUsd } from '../../src/agent'
import type { Sql } from '../../src/db'
import {
  epoch,
  type Meter,
  rowsOf,
  type ScenarioResult,
  seedLedger,
  type TurnResult,
} from '../scenarios/drive'
import { gradeTurn } from '../scenarios/grade'
import type { Scenario, Turn } from '../scenarios/schema'
import type { FakeGraph, Sent } from './fake-graph'
import { type Inbound, postWebhook, webhookBody } from './webhook'

/** The failure notice the WhatsApp channel posts when a turn does not complete (agent/channels/whatsapp.ts). */
const FAILURE_NOTICE = 'No pude procesar tu mensaje. Probá de nuevo en un rato.'

export interface EveEnv {
  sql: Sql
  graph: FakeGraph
  /** The eve server, e.g. http://localhost:3100. */
  base: string
  meter: Meter
  /** Distinguishes this run's senders from earlier runs (eve keeps a session per sender). */
  run: string
}

/** One fake sender per scenario and run: a new session each time, and scenarios can run side by side. */
export const waIdOfRun = (id: string, run: string) =>
  `54911${id.slice(1).padStart(5, '0')}${run.padStart(3, '0')}`

export interface EveTurnExtra {
  /** Webhook post to the first typing indicator (the first signal). */
  firstSignalMs: number | null
  /** The model's own words before code checked them, to see what the guards changed. */
  guard: { replaced: boolean; unknown: string[] } | null
}

const isTextTo =
  (waId: string) =>
  (x: Sent): x is Extract<Sent, { kind: 'text' }> =>
    x.kind === 'text' && x.to === waId

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios', 'fixtures')

/** The inbound message of a turn: its text, or its photo (served by the fake Graph) with the text as caption. */
function messageOf(turn: Turn, env: EveEnv, key: string): Inbound['message'] {
  if (!turn.image) return { type: 'text', text: { body: turn.text } }
  const id = `media.${key}`
  const data = readFileSync(join(fixtures, turn.image))
  env.graph.media.set(id, { mime: 'image/png', data })
  return {
    type: 'image',
    image: {
      id,
      mime_type: 'image/png',
      sha256: createHash('sha256').update(data).digest('hex'),
      caption: turn.text,
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const actionOf = (tools: string[], reply: string): TurnResult['action'] => {
  if (reply.trim().startsWith('¿')) return 'ask'
  const writes = tools.filter((t) =>
    ['log_movements', 'correct_movement', 'delete_movement'].includes(t),
  )
  if (writes.length > 1) return 'multi'
  if (writes[0] === 'log_movements') return 'log'
  if (writes[0] === 'correct_movement') return 'correct'
  if (writes[0] === 'delete_movement') return 'delete'
  if (tools.includes('summarize')) return 'query'
  return 'other'
}

interface Played {
  reply: string
  wallMs: number
  firstSignalMs: number | null
}

/** A text turn: a signed webhook into the Chat SDK WhatsApp channel; the reply is the next text the fake Graph gets for this sender. */
async function playOverWhatsApp(
  env: EveEnv,
  waId: string,
  key: string,
  turn: Turn,
  started: number,
  sentBefore: number,
): Promise<Played> {
  const res = await postWebhook(
    env.base,
    webhookBody({
      wamid: `wamid.${key}`,
      from: waId,
      timestamp: Math.floor(epoch(turn.now) / 1000),
      message: messageOf(turn, env, key),
    }),
  )
  if (!res.ok) throw new Error(`webhook ${res.status}`)
  const deadline = Date.now() + 90_000
  for (;;) {
    const next = env.graph.sent.filter(isTextTo(waId))[sentBefore]
    if (next) {
      const typing = env.graph.sent.find(
        (x) => x.kind === 'typing' && x.messageId === `wamid.${key}` && x.at >= started,
      )
      return {
        reply: next.body,
        wallMs: next.at - started,
        firstSignalMs: typing ? typing.at - started : null,
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the reply to ${key}`)
    await sleep(15)
  }
}

/** One HTTP-channel session per sender, for the turns that carry a photo (see playOverHttp). */
const httpSessions = new Map<string, ClientSession>()

/**
 * A photo turn. The Chat SDK WhatsApp adapter only downloads media from a public https host (its SSRF
 * guard refuses loopback), so a local fake Graph cannot serve one. The same photo goes through eve's own
 * attachment path instead: a file part on the HTTP channel. That channel has no hook to check the final
 * text, so the driver applies the same `finalize()` the WhatsApp channel does.
 */
async function playOverHttp(
  env: EveEnv,
  waId: string,
  turn: Turn,
  started: number,
): Promise<Played> {
  const client = new Client({
    baseUrl: env.base,
    headers: { 'x-warren-user': waId, 'x-warren-secret': 'spike-local' },
  })
  const data = readFileSync(join(fixtures, turn.image ?? '')).toString('base64')
  const message = [
    { type: 'text' as const, text: turn.text },
    {
      type: 'file' as const,
      mediaType: 'image/png',
      filename: turn.image ?? 'photo.png',
      data: `data:image/png;base64,${data}`,
    },
  ]
  let session = httpSessions.get(waId)
  let delivery: Delivery
  if (session) delivery = await session.send(message)
  else {
    const created = await client.sessions.create({ message })
    session = created.session
    delivery = created.delivery
    httpSessions.set(waId, session)
  }
  const result = await delivery.result()
  const wallMs = performance.now() - started
  if (result.status !== 'completed') return { reply: FAILURE_NOTICE, wallMs, firstSignalMs: null }
  const lines: string[] = []
  const outputs: unknown[] = []
  for await (const e of session.stream({ startIndex: 0, follow: false })) {
    if (e.type === 'call.settled') {
      const out = (e.data as { output?: { line?: unknown } }).output
      outputs.push(out)
      if (typeof out?.line === 'string') lines.push(out.line)
    }
  }
  const out = finalize({
    modelText: result.reply ?? '',
    lines,
    facts: [JSON.stringify(outputs), turn.text],
  })
  return { reply: out.text || FALLBACK_TEXT, wallMs, firstSignalMs: null }
}

/**
 * Plays one scenario through eve: signed webhooks into the Chat SDK WhatsApp channel, the agent on the
 * model, replies read off the fake Graph, the database graded by the same `gradeTurn` as our loop. Like
 * the loop's driver, it stops at the first turn that is not right.
 */
export async function runScenarioEve(
  s: Scenario,
  env: EveEnv,
): Promise<ScenarioResult & { extras: EveTurnExtra[] }> {
  const waId = waIdOfRun(s.id, env.run)
  const base = { id: s.id, split: s.split, tags: s.tags }
  const turns: TurnResult[] = []
  const extras: EveTurnExtra[] = []
  const fail = (
    status: ScenarioResult['status'],
    error: string | null,
    failedTurn: number | null,
  ) => ({ ...base, status, turns, failedTurn, error, extras })
  try {
    const refs = await seedLedger(env.sql, s, waId)
    for (const [k, turn] of s.turns.entries()) {
      const before = await rowsOf(env.sql, waId)
      await env.sql`INSERT INTO spike_clock (wa_id, now) VALUES (${waId}, ${turn.now})
        ON CONFLICT (wa_id) DO UPDATE SET now = EXCLUDED.now`
      const [{ movementMax = 0, inboundMax = 0, usageMax = 0, guardMax = 0 } = {}] = await env.sql<
        { movementMax: number; inboundMax: number; usageMax: number; guardMax: number }[]
      >`SELECT
          coalesce((SELECT max(id) FROM movement), 0)::int AS "movementMax",
          coalesce((SELECT max(id) FROM inbound_message), 0)::int AS "inboundMax",
          coalesce((SELECT max(id) FROM spike_usage), 0)::int AS "usageMax",
          coalesce((SELECT max(id) FROM spike_guard), 0)::int AS "guardMax"`
      const sentBefore = env.graph.sent.filter(isTextTo(waId)).length
      env.meter.begin()
      let cost: number | null = null
      try {
        const started = performance.now()
        const played = turn.image
          ? await playOverHttp(env, waId, turn, started)
          : await playOverWhatsApp(env, waId, `${s.id}.${env.run}.${k}`, turn, started, sentBefore)
        const { reply, wallMs, firstSignalMs } = played
        // The audit lands after the reply is posted; give the hooks a beat.
        await sleep(60)

        // New movements are stamped with the turn's own clock, as the loop's driver does.
        await env.sql`UPDATE movement SET created_at = ${new Date(epoch(turn.now)).toISOString()}
          WHERE id > ${movementMax}
            AND account_id = (SELECT id FROM account WHERE wa_id = ${waId})
            AND NOT EXISTS (SELECT 1 FROM movement o WHERE o.superseded_by = movement.id)`
        const after = await rowsOf(env.sql, waId)
        const audit = await env.sql<
          { tool_calls: { tool: string; input: unknown; status: string }[] | null }[]
        >`
          SELECT tool_calls FROM inbound_message WHERE wa_id = ${waId} AND id > ${inboundMax} AND wamid LIKE 'eve.%'`
        const toolCalls = audit.flatMap((r) => r.tool_calls ?? [])
        const tools = toolCalls.map((c) => c.tool)
        const usage = await env.sql<
          { input: number; output: number; cacheRead: number; cacheWrite: number }[]
        >`SELECT input_tokens AS input, output_tokens AS output, cache_read_tokens AS "cacheRead",
            cache_write_tokens AS "cacheWrite" FROM spike_usage WHERE wa_id = ${waId} AND id > ${usageMax}`
        cost = usage.reduce(
          (sum, u) =>
            sum +
            estimateCostUsd('haiku', {
              // `inputTokens` here is the provider's total; the price table wants the uncached part.
              inputTokens: u.input - u.cacheRead - u.cacheWrite,
              outputTokens: u.output,
              cacheReadTokens: u.cacheRead,
              cacheWriteTokens: u.cacheWrite,
            }),
          0,
        )
        const failed = reply.trim() === FAILURE_NOTICE
        const guards = await env.sql<{ detail: { unknown: string[] } }[]>`
          SELECT detail FROM spike_guard WHERE wa_id = ${waId} AND id > ${guardMax}`
        const grade = gradeTurn({
          turn,
          today: turn.now.slice(0, 10),
          before,
          after,
          refs,
          reply,
          failed,
          commandType: tools.includes('summarize') ? 'query' : 'eve',
        })
        refs.clear()
        for (const [ref, id] of grade.refs) refs.set(ref, id)
        turns.push({
          text: turn.text,
          now: turn.now,
          reply,
          grade,
          wallMs,
          modelMs: null,
          modelTurns: usage.length,
          action: actionOf(tools, reply),
          parsed: toolCalls.map((c) => ({ tool: c.tool, input: c.input, status: c.status })),
          error: failed ? 'failure notice' : null,
          costUsd: cost,
        })
        extras.push({
          firstSignalMs,
          guard: guards[0] ? { replaced: true, unknown: guards[0].detail.unknown } : null,
        })
        if (!grade.ok) return fail('fail', null, k)
      } finally {
        env.meter.end(cost)
      }
    }
    return fail('pass', null, null)
  } catch (error) {
    if (env.meter.exhausted) return fail('budget', null, null)
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error)
    return fail('error', message, turns.length)
  }
}
