import type { Input } from '../core/commands'
import type { Sql } from '../core/db'
import { renderSummary, type Side } from '../render-summary'
import { planRange, type Resolved } from './range'
import { summaryRows } from './totals'

/** What a summary found: the range asked about, the range it is compared with (if any), and the reply code renders from them. */
export interface RanSummary {
  current: Side
  previous: Side | null
  /** The reply, line by line (`renderSummary`). */
  lines: string[]
}

/**
 * Runs a summary the model or an MCP client asked for: plans the days, sums them in SQL (the asked range and, when it is compared,
 * the other one) and renders the reply. One path for WhatsApp and MCP, so the numbers are the same. `checkValues` has already planned
 * this against the same day: a failure here is a bug, not a refusal.
 */
export async function runSummary(
  sql: Sql,
  accountId: number,
  q: Input<'summarize'>,
  today: string,
): Promise<RanSummary> {
  const plan = planRange(q, today)
  if (typeof plan === 'string') throw new Error(`summarize: ${plan}`)
  const group = q.group_by ?? 'none'
  const filter = {
    direction: q.direction ?? null,
    category: q.category ?? null,
    payment: q.payment ?? null,
    description: q.description ?? null,
  }
  const side = async (range: Resolved): Promise<Side> => ({
    range,
    ...(await summaryRows(sql, accountId, { ...filter, range }, group)),
  })
  const current = await side(plan.asked)
  const previous = plan.before ? await side(plan.before) : null
  const lines = renderSummary({ ...filter, groupBy: group }, today, current, previous)
  return { current, previous, lines }
}
