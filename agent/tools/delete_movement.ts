import { defineTool } from 'eve/tools'
import { TOOL_INPUTS } from '../../src/agent/schema'
import { lockLive, newestLiveId, softDelete } from '../../src/ledger'
import { REPLY_GONE, renderDeletion } from '../../src/render'
import { accountOf, callerOf, inTx, ledger, lockTurn, nowOf, turnRow } from '../lib/core'
import { notShown, unseen } from '../lib/guards'

export default defineTool({
  description:
    'Delete one existing movement, by id. Code stamps it deleted (it is never removed) and returns the confirmation line it shows the person.',
  inputSchema: TOOL_INPUTS.delete_movement(),
  // Guard 2 (only ids shown): refused before the call starts, with a reason the model reads.
  approval: ({ toolInput }) => {
    const bad = unseen([(toolInput as { id?: number } | undefined)?.id ?? 0])
    return bad.length > 0 ? { type: 'denied', reason: notShown(bad) } : 'not-applicable'
  },
  async execute({ id }, ctx) {
    const sql = ledger()
    const waId = callerOf(ctx)
    const { today } = await nowOf(sql, waId)
    const accountId = await accountOf(sql, waId)
    const inboundId = await turnRow(sql, {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      waId,
    })
    return inTx(sql, async (tx) => {
      await lockTurn(tx, inboundId)
      const old = await lockLive(tx, accountId, id)
      if (!old) return { outcome: 'gone' as const, line: REPLY_GONE }
      const newest = old.id === (await newestLiveId(tx, accountId))
      await softDelete(tx, old.id, inboundId)
      return { outcome: 'applied' as const, line: renderDeletion(old, today, newest) }
    })
  },
})
