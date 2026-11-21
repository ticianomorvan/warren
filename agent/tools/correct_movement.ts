import { defineTool } from 'eve/tools'
import { TOOL_INPUTS } from '../../src/agent/schema'
import { checkChanges, hasChanges, issueText } from '../../src/agent/validate'
import { lockLive, newestLiveId, supersede } from '../../src/ledger'
import { applyChanges, changedFields } from '../../src/movement'
import { REPLY_GONE, renderCorrection, renderUnchanged } from '../../src/render'
import { accountOf, callerOf, inTx, ledger, lockTurn, nowOf, turnRow } from '../lib/core'
import { notShown, unseen } from '../lib/guards'
import { markShown } from '../lib/state'

export default defineTool({
  description:
    'Change fields of one existing movement, by id. Only the fields that change are sent. Code applies the change as a new row and returns the confirmation line it shows the person.',
  inputSchema: TOOL_INPUTS.correct_movement(),
  // Guard 2 (only ids shown): refused before the call starts, with a reason the model reads.
  approval: ({ toolInput }) => {
    const bad = unseen([(toolInput as { id?: number } | undefined)?.id ?? 0])
    return bad.length > 0 ? { type: 'denied', reason: notShown(bad) } : 'not-applicable'
  },
  async execute({ id, changes }, ctx) {
    const sql = ledger()
    const waId = callerOf(ctx)
    const { today } = await nowOf(sql, waId)
    const issues = checkChanges(changes, today)
    if (issues.length > 0) throw new Error(issueText(issues))
    if (!hasChanges(changes)) throw new Error('changes is empty: ask the person what to change')
    const accountId = await accountOf(sql, waId)
    const inboundId = await turnRow(sql, {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      waId,
    })
    const result = await inTx(sql, async (tx) => {
      await lockTurn(tx, inboundId)
      // Owned and live, under a row lock (guard 1).
      const old = await lockLive(tx, accountId, id)
      if (!old) return { outcome: 'gone' as const, line: REPLY_GONE }
      const next = applyChanges(old, changes)
      const changed = changedFields(old, next)
      if (changed.length === 0) {
        return { outcome: 'unchanged' as const, line: renderUnchanged(old, today) }
      }
      const newest = old.id === (await newestLiveId(tx, accountId))
      const [{ n = 0 } = {}] = await tx<{ n: number }[]>`
        SELECT coalesce(max(position) + 1, 0)::int AS n FROM movement
        WHERE inbound_message_id = ${inboundId}`
      await supersede(tx, { accountId, inboundId, old, next, position: n })
      const [row] = await tx<{ id: number }[]>`
        SELECT superseded_by::int AS id FROM movement WHERE id = ${old.id}`
      return {
        outcome: 'applied' as const,
        line: renderCorrection(old, next, changed, today, newest),
        newId: row?.id,
      }
    })
    if (result.outcome === 'applied' && result.newId) markShown([result.newId])
    return result
  },
})
