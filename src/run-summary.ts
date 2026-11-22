import type { ToolInput } from './agent/schema'
import type { Sql } from './core/db'
import { planSummary, type Resolved } from './domain/range'
import { summaryRows } from './ledger'
import { renderSummary, type Side } from './render-summary'

/** What a summary found: the range asked about, the range it is compared with (if any), and the reply code renders from them. */
export interface RanSummary {
  current: Side
  previous: Side | null
  /** The reply, line by line (`renderSummary`). */
  lines: string[]
}

/**
 * Runs a summary the model or an MCP client asked for: plans the days, sums them in SQL (the asked range and, when it is
 * compared, the other one) and renders the reply. One path for WhatsApp (`execute`) and MCP, so the numbers are the same.
 * `checkCall` has already planned this against the same day: a failure here is a bug, not a refusal.
 */
export async function runSummary(
  tx: Sql,
  accountId: number,
  q: ToolInput<'summarize'>,
  today: string,
): Promise<RanSummary> {
  const plan = planSummary(q, today)
  if (typeof plan === 'string') throw new Error(`summarize: ${plan}`)
  const { group_by, direction, category, payment, description } = q
  const side = async (r: Resolved): Promise<Side> => ({
    range: r,
    ...(await summaryRows(
      tx,
      accountId,
      { direction, category, payment, description, range: r },
      group_by,
    )),
  })
  const current = await side(plan.asked)
  const previous = plan.before ? await side(plan.before) : null
  const lines = renderSummary(
    { direction, category, payment, description, groupBy: group_by },
    today,
    current,
    previous,
  )
  return { current, previous, lines }
}
