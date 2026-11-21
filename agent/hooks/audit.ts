import { call } from 'eve/events'
import { defineHook } from 'eve/hooks'
import { ensureSpikeTables, ledger } from '../lib/core'

/**
 * Guard 6, the audit: every tool call of every turn is written to the turn's `inbound_message.tool_calls`
 * (the same column the loop fills), including a call a policy refused, which the tool never saw. Model
 * usage goes to `spike_usage`, for the eval's cost. Hooks run after the event is recorded and cannot
 * change it.
 */
export default defineHook({
  events: {
    async 'call.settled'(event, ctx) {
      const waId = ctx.session.auth.current?.principalId
      const observed = call(ctx.view, event.data.callId)
      if (!waId || !observed || observed.kind !== 'tool') return
      const turnId = observed.turnId ?? ctx.turn?.id ?? 'unknown'
      const sql = ledger()
      const wamid = `eve.${ctx.session.id}.${turnId}`
      const entry = {
        tool: observed.name,
        input: observed.input,
        status: event.data.outcome,
        output: observed.output ?? null,
        callId: event.data.callId,
      }
      await sql`
        INSERT INTO inbound_message (wamid, wa_id, kind, payload, status, tool_calls)
        VALUES (${wamid}, ${waId}, 'text', '{}'::jsonb, 'done', ${sql.json([entry])})
        ON CONFLICT (wamid) DO UPDATE SET
          tool_calls = coalesce(inbound_message.tool_calls, '[]'::jsonb) || ${sql.json([entry])},
          updated_at = now()`
    },
    async 'usage.recorded'(event, ctx) {
      const waId = ctx.session.auth.current?.principalId
      if (!waId || event.data.kind !== 'model') return
      const sql = ledger()
      await ensureSpikeTables(sql)
      const u = event.data.usage
      await sql`INSERT INTO spike_usage (wa_id, turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
        VALUES (${waId}, ${`${ctx.session.id}/${ctx.turn?.id ?? ''}`}, ${u.inputTokens ?? 0}, ${u.outputTokens ?? 0}, ${u.cacheReadTokens ?? 0}, ${u.cacheWriteTokens ?? 0})`
    },
  },
})
