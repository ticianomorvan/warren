import { defineTool } from 'eve/tools'
import { TOOL_INPUTS } from '../../src/agent/schema'
import { checkCount, checkLog, issueText } from '../../src/agent/validate'
import { insertMovements } from '../../src/ledger'
import { renderLog } from '../../src/render'
import { accountOf, callerOf, inTx, ledger, lockTurn, nowOf, turnRow } from '../lib/core'
import { markShown } from '../lib/state'

export default defineTool({
  description:
    'Record 1 to 10 new movements (expenses or income) the person tells you about. Code validates them, saves them and returns the confirmation line it shows the person.',
  inputSchema: TOOL_INPUTS.log_movements(),
  async execute({ movements }, ctx) {
    const sql = ledger()
    const waId = callerOf(ctx)
    const { today } = await nowOf(sql, waId)
    const accountId = await accountOf(sql, waId)
    const inboundId = await turnRow(sql, {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      waId,
    })
    const ids = await inTx(sql, async (tx) => {
      await lockTurn(tx, inboundId)
      // The cap counts every movement this turn logged, over all its calls (guard 3).
      const [{ n = 0 } = {}] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM movement m
        WHERE m.inbound_message_id = ${inboundId}
          AND NOT EXISTS (SELECT 1 FROM movement o WHERE o.superseded_by = m.id)`
      const issues = [...checkLog(movements, today), ...checkCount(n + movements.length)]
      if (issues.length > 0) throw new Error(issueText(issues))
      const [{ next = 0 } = {}] = await tx<{ next: number }[]>`
        SELECT coalesce(max(position) + 1, 0)::int AS next FROM movement
        WHERE inbound_message_id = ${inboundId}`
      return insertMovements(tx, { accountId, inboundId, movements, firstPosition: next })
    })
    markShown(ids)
    return { line: renderLog(movements, today), ids }
  },
})
