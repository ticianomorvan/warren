import { createMemoryState } from '@chat-adapter/state-memory'
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp'
import { chatSdkChannel, messageContentOf } from 'eve/channels/chat-sdk'
import { calls, deliveries, reply as replyOf } from 'eve/events'
import { ensureSpikeTables, ledger } from '../lib/core'
import { FALLBACK_TEXT, finalize } from '../lib/finalize'
import { lastShown, turnFacts } from '../lib/state'

/**
 * WhatsApp through the Chat SDK adapter. The spike only ever points it at a fake Graph:
 * `WARREN_SPIKE_GRAPH_URL` must be set, and no real token is ever given to the adapter.
 */
const graphUrl = process.env.WARREN_SPIKE_GRAPH_URL
if (!graphUrl) throw new Error('WARREN_SPIKE_GRAPH_URL is required: the spike never talks to Meta')
const PHONE_NUMBER_ID = '123456789012345'

export const { bot, channel, send } = chatSdkChannel({
  userName: 'Warren',
  adapters: {
    whatsapp: createWhatsAppAdapter({
      accessToken: 'spike-fake-token',
      appSecret: 'spike-app-secret',
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: 'spike-verify',
      apiUrl: graphUrl,
      userName: 'Warren',
    }),
  },
  state: createMemoryState(),
  // WhatsApp cannot edit a sent message: the reply is posted once, by the handler below.
  streaming: false,
  events: {
    // The default posts each reply part as it completes. Warren posts one checked reply per turn instead.
    'content.completed'() {},
    // The default posts eve's English "session could not recover" text with an error id. The notice above is
    // the only failure message the person gets.
    'session.ended'() {},
    async 'turn.settled'(event, ctx) {
      const thread = ctx.channel.thread
      if (!thread) return
      const turnId = event.data.turnId
      if (event.data.outcome !== 'completed') {
        await thread.post({ markdown: 'No pude procesar tu mensaje. Probá de nuevo en un rato.' })
        return
      }
      const view = ctx.view
      const modelText = replyOf(view, turnId)
        .map((p) => (typeof p.value === 'string' ? p.value : ''))
        .join('\n')
      const thisTurn = calls(view, { kind: 'tool', turnId }).filter((c) => c.state === 'completed')
      const outputs = thisTurn.map((c) => c.output as { line?: unknown } | undefined)
      const lines = outputs.flatMap((o) => (typeof o?.line === 'string' ? [o.line] : []))
      // Facts: what the person wrote and the context code gave the model (this turn), the results of this
      // turn's tools, and what Warren's tools returned earlier in the session (the audit, in the ledger
      // database: the channel's view only keeps the running turn).
      const earlier = await sessionOutputs(ctx.session.id)
      const facts = [
        JSON.stringify(thisTurn.map((c) => c.output)),
        earlier,
        turnFacts.get().text,
        userTextOf(view, turnId),
      ]
      const out = finalize({ modelText, lines, facts })
      if (out.replaced) await logGuard(ctx.session.auth.current?.principalId ?? '', turnId, out)
      // Never silent: an empty answer still gets a line.
      const shown = out.text || FALLBACK_TEXT
      lastShown.update(() => ({ text: shown }))
      await thread.post({ markdown: shown })
    },
  },
})

bot.onNewMention(async (thread, message) => {
  await thread.subscribe()
  await dispatch(thread, message)
})
bot.onSubscribedMessage(async (thread, message) => {
  await dispatch(thread, message)
})

async function dispatch(
  thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
  message: Parameters<Parameters<typeof bot.onNewMention>[0]>[1],
) {
  await send(messageContentOf(message), {
    thread,
    idempotencyKey: message.id,
    auth: {
      authenticator: 'whatsapp',
      principalType: 'user',
      principalId: message.author.userId,
      attributes: {},
    },
  })
}

/** Every tool result the session has audited so far, as text. */
async function sessionOutputs(sessionId: string): Promise<string> {
  const sql = ledger()
  const rows = await sql<{ tool_calls: unknown }[]>`
    SELECT tool_calls FROM inbound_message WHERE wamid LIKE ${`eve.${sessionId}.%`}`
  return JSON.stringify(rows.map((r) => r.tool_calls))
}

/** What the person wrote in this turn (text parts of the deliveries it consumed). */
function userTextOf(view: Parameters<typeof calls>[0], turnId: string): string {
  return deliveries(view, { turnId })
    .flatMap((d) => d.parts ?? [])
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('\n')
}

async function logGuard(waId: string, turnId: string, out: { unknown: string[] }) {
  const sql = ledger()
  await ensureSpikeTables(sql)
  await sql`INSERT INTO spike_guard (wa_id, turn_id, kind, detail)
    VALUES (${waId}, ${turnId}, 'numbers', ${sql.json({ unknown: out.unknown })})`
}

export default channel
