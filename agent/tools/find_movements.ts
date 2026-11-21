import { defineTool } from 'eve/tools'
import { movementLine } from '../../src/agent/prompt'
import { MAX_FOUND, TOOL_INPUTS } from '../../src/agent/schema'
import { isDecimalAmount, isIsoDate } from '../../src/agent/validate'
import { findMovements } from '../../src/ledger'
import { accountOf, callerOf, ledger } from '../lib/core'
import { markShown } from '../lib/state'

export default defineTool({
  description:
    "Search the person's whole history for a movement that is not in the list of the 10 newest. Returns up to 20 live movements with their ids, newest first. Leave out the filters you do not need.",
  inputSchema: TOOL_INPUTS.find_movements(),
  async execute(f, ctx) {
    const issues = [
      ...(f.amount != null && !isDecimalAmount(f.amount) ? ['amount is not a decimal string'] : []),
      ...[f.from, f.to].flatMap((d) =>
        d != null && !isIsoDate(d) ? ['dates are yyyy-mm-dd'] : [],
      ),
    ]
    if (issues.length > 0) throw new Error(issues.join('; '))
    const sql = ledger()
    const accountId = await accountOf(sql, callerOf(ctx))
    const rows = await findMovements(sql, accountId, {
      text: f.text ?? null,
      from: f.from ?? null,
      to: f.to ?? null,
      category: f.category ?? null,
      payment: f.payment ?? null,
      amount: f.amount ?? null,
      limit: Math.min(Math.max(f.limit ?? 10, 1), MAX_FOUND),
    })
    markShown(rows.map((r) => r.id))
    return {
      found: rows.length,
      movements: rows.map(movementLine),
    }
  },
})
