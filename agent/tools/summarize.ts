import { defineTool } from 'eve/tools'
import { TOOL_INPUTS } from '../../src/agent/schema'
import { queryTotals } from '../../src/ledger'
import { renderQuery } from '../../src/render'
import { periodRange } from '../../src/time'
import { accountOf, callerOf, ledger, nowOf } from '../lib/core'

export default defineTool({
  description:
    'Answer how much the person spent or received in a period. Code computes the totals and returns the line it shows the person; you only choose the period and filters.',
  inputSchema: TOOL_INPUTS.summarize(),
  async execute(scope, ctx) {
    const sql = ledger()
    const waId = callerOf(ctx)
    const { today } = await nowOf(sql, waId)
    const accountId = await accountOf(sql, waId)
    const totals = await queryTotals(sql, accountId, {
      direction: scope.direction,
      category: scope.category,
      payment: scope.payment,
      range: periodRange(scope.period, today),
    })
    return { line: renderQuery(scope, totals) }
  },
})
