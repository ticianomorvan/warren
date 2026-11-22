import { createHash } from 'node:crypto'
import { type McpServer, requireScopes } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { whatsappAddress } from '../access'
import type { Outcome } from '../core/apply'
import {
  type Call,
  COMMANDS,
  type GROUPS,
  type McpBlock,
  type OUTPUTS,
  type Tool,
  type WriteTool,
  writes,
} from '../core/commands'
import type { Sql } from '../core/db'
import { declineLine, REPLY } from '../core/describe'
import { money } from '../core/es'
import { checkValues } from '../core/guards'
import type { Undone } from '../core/history'
import { commit, lockAccount } from '../core/turn'
import { allLiveFacts, type FactRow } from '../domain/facts'
import { findMovements, type MovementRow } from '../domain/movements'
import { liveReminders, type ReminderRow } from '../domain/reminders/db'
import { describeReminder } from '../domain/reminders/describe'
import { groupLabel, MAX_BUCKETS, rangeLabel, type Side } from '../domain/render-summary'
import { runSummary } from '../domain/run-summary'
import { change, formatPercent } from '../domain/summary'
import { type GroupTotal, isTimeGroup, type QueryTotal } from '../domain/totals'
import { log } from '../log'
import { argentinaToday } from '../time'

/**
 * Warren's MCP tools, all of them built from the registry: every entry that has an `mcp` block is a tool, with the entry's own input
 * (plus the fields only a client sends: `request_id`, a page) and a real output schema. A read runs its query; a write goes through the
 * same `checkValues` and `commit` as WhatsApp's, on the channel `mcp`, so there is one write path and one undo. `accountId` is the door's:
 * no tool takes it from its input, and every query takes it.
 */

export interface ToolContext {
  sql: Sql
  /** The person: from the verified token, never from an argument. */
  accountId: number
  now: () => Date
}

/** A page of `warren_find_movements`: 25 rows are about 3k tokens, far under what a client takes in one result. */
export const DEFAULT_PAGE = 25
/** Groups listed per direction and currency in a summary that is not by time (the biggest first); a grouping by time keeps the latest `MAX_BUCKETS`. */
export const MAX_GROUPS_LISTED = 100

const QUOTE =
  'Every amount is computed by Warren: quote the amounts and totals as given (use `display` when showing money) and never add, subtract, convert or round them yourself.'
const WRITES =
  'Writes the same ledger and memory as WhatsApp, through the same checks; the person can undo it from WhatsApp ("deshacer") and `warren_undo_last` takes back the newest change of either channel. Nothing is overwritten: a correction adds a version and a delete only marks the movement. The result carries `record`, what changed as Warren writes it (Spanish).'

type Result = {
  isError?: true
  structuredContent: Record<string, unknown>
  content: { type: 'text'; text: string }[]
}

const done = (output: Record<string, unknown>): Result => ({
  structuredContent: output,
  content: [{ type: 'text', text: JSON.stringify(output) }],
})

/** A call that was refused or changed nothing: a typed `code` for the client's agent, and the line Warren says. */
export const fail = (code: string, message: string): Result => ({
  isError: true,
  structuredContent: { code, message },
  content: [{ type: 'text', text: message }],
})

const unavailable = (tool: string, error: unknown) => {
  log('mcp_tool_failed', { tool, error: error instanceof Error ? error.name : 'unknown' }, 'error')
  return fail('unavailable', 'Warren could not read your data right now. Try again in a moment.')
}

// ---- The cursor of a page: the version the next page starts below, opaque to the client.

export const encodeCursor = (beforeVersion: number): string =>
  Buffer.from(`m${beforeVersion}`).toString('base64url')

/** The version inside a cursor we made, or null for anything else. */
export function decodeCursor(cursor: string): number | null {
  if (cursor.length > 32 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const n = /^m([1-9]\d{0,14})$/.exec(text)?.[1]
  return n !== undefined && encodeCursor(Number(n)) === cursor ? Number(n) : null
}

// ---- What each tool shows

type Out<T extends Tool> = T extends keyof typeof OUTPUTS ? z.infer<(typeof OUTPUTS)[T]> : never

const movementView = (m: MovementRow) => ({
  id: m.id,
  date: m.date,
  time: m.time,
  direction: m.direction,
  amount: m.amount,
  display: money(m.amount, m.currency),
  currency: m.currency,
  description: m.description,
  category: m.category,
  payment: m.payment,
})
const factView = (f: FactRow) => ({ id: f.id, kind: f.kind, key: f.key, value: f.value })
const reminderView = (r: ReminderRow, today: string) => ({
  id: r.id,
  what: r.what,
  next_due_at: r.nextDueAt ? r.nextDueAt.toISOString() : null,
  when: describeReminder(r, today),
})

const totalView = (t: QueryTotal) => ({
  direction: t.direction,
  currency: t.currency,
  count: t.count,
  amount: t.total,
  display: money(t.total, t.currency),
})

/** The groups of a range that are listed, and how many are left out: each direction and currency has its own, so one never crowds another out. */
export function listGroups(groups: GroupTotal[], by: (typeof GROUPS)[number]) {
  const perPair = new Map<string, GroupTotal[]>()
  for (const g of groups) {
    const pair = `${g.direction}:${g.currency}`
    perPair.set(pair, [...(perPair.get(pair) ?? []), g])
  }
  const listed: GroupTotal[] = []
  for (const all of perPair.values()) {
    listed.push(
      ...(isTimeGroup(by)
        ? all.slice(-MAX_BUCKETS) // oldest first: the latest are the last
        : all.slice(0, MAX_GROUPS_LISTED)),
    )
  }
  return { listed, omitted: groups.length - listed.length }
}

const sideView = (s: Side, by: (typeof GROUPS)[number], today: string) => {
  const { listed, omitted } = listGroups(s.groups, by)
  return {
    from: s.range.from,
    to: s.range.to,
    label: rangeLabel(s.range, today),
    totals: s.totals.map(totalView),
    groups: listed.map((g) => ({ key: g.key, label: groupLabel(by, g, today), ...totalView(g) })),
    groups_omitted: omitted,
  }
}

/** How the asked range went from the compared one, per direction and currency, from `summary.ts` (exact, in cents). */
function changesView(now: Side, before: Side) {
  const pairs = new Map<string, { direction: 'in' | 'out'; currency: 'ARS' | 'USD' }>()
  for (const t of [...now.totals, ...before.totals]) {
    pairs.set(`${t.direction}:${t.currency}`, { direction: t.direction, currency: t.currency })
  }
  const total = (side: Side, p: { direction: string; currency: string }) =>
    side.totals.find((t) => t.direction === p.direction && t.currency === p.currency)?.total ?? '0'
  return [...pairs.values()].map((p) => {
    const c = change(total(now, p), total(before, p))
    return {
      ...p,
      way: c.way,
      amount: c.amount,
      display: money(c.amount, p.currency),
      percent: c.tenths === null ? null : formatPercent(c.tenths),
    }
  })
}

function undoneItem(u: Undone, today: string): Out<'undo_last'>['items'][number] {
  switch (u.kind) {
    case 'logged':
    case 'deleted':
      return { kind: u.kind, movement: movementView(u.movement) }
    case 'corrected':
      return { kind: u.kind, movement: movementView(u.to), from: movementView(u.from) }
    case 'fact_removed':
    case 'fact_restored':
      return { kind: u.kind, fact: factView(u.fact) }
    case 'fact_reverted':
      return { kind: u.kind, fact: factView(u.fact), was: u.was }
    case 'reminder_removed':
    case 'reminder_restored':
      return { kind: u.kind, reminder: reminderView(u.reminder, today) }
  }
}

// ---- Reads

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

async function find(c: ToolContext, input: Record<string, unknown>) {
  const { limit = DEFAULT_PAGE, cursor, ...filter } = input as { limit?: number; cursor?: string }
  const now = c.now()
  const checked = checkValues('find_movements', filter, { today: argentinaToday(now), now })
  if (checked.kind !== 'read') {
    return fail('invalid', checked.kind === 'rejected' ? checked.message : 'invalid input')
  }
  let beforeVersion: number | undefined
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor)
    if (decoded === null)
      return fail('invalid', 'Invalid cursor. Use the `next_cursor` of a previous result.')
    beforeVersion = decoded
  }
  // One more than a page, to know whether there is a next one.
  const rows = await findMovements(
    c.sql,
    c.accountId,
    { ...checked.filter, limit: limit + 1 },
    beforeVersion ? { beforeVersion } : {},
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const output: Out<'find_movements'> = {
    movements: page.map(movementView),
    next_cursor: rows.length > limit && last ? encodeCursor(last.version) : null,
  }
  return done(output)
}

async function summarizeTool(c: ToolContext, input: Record<string, unknown>) {
  const now = c.now()
  const today = argentinaToday(now)
  const checked = checkValues('summarize', input, { today, now })
  if (checked.kind !== 'ok' || checked.call.tool !== 'summarize') {
    return fail('invalid', checked.kind === 'rejected' ? checked.message : 'invalid input')
  }
  const q = checked.call.input
  // One snapshot for the asked range and the compared one.
  const ran = await c.sql.begin('isolation level repeatable read read only', (tx) =>
    runSummary(tx as unknown as Sql, c.accountId, q, today),
  )
  const by = q.group_by ?? 'none'
  const output: Out<'summarize'> = {
    ...sideView(ran.current, by, today),
    compared_with: ran.previous ? sideView(ran.previous, by, today) : null,
    changes: ran.previous ? changesView(ran.current, ran.previous) : [],
    summary: ran.lines.join('\n'),
  }
  return done(output)
}

const READS: Partial<
  Record<Tool, (c: ToolContext, input: Record<string, unknown>) => Promise<Result>>
> = {
  find_movements: find,
  summarize: summarizeTool,
  list_facts: async (c) => {
    const facts = await allLiveFacts(c.sql, c.accountId)
    const output: Out<'list_facts'> = { facts: facts.map(factView), total: facts.length }
    return done(output)
  },
  list_reminders: async (c) => {
    const today = argentinaToday(c.now())
    const rows = await liveReminders(c.sql, c.accountId)
    const output: Out<'list_reminders'> = { reminders: rows.map((r) => reminderView(r, today)) }
    return done(output)
  },
}

// ---- Writes

/** JSON with the keys of every object in order: the same call always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What identifies a call: its tool and its checked input. A request id may only ever stand for one of these. */
const callHash = (call: Call) =>
  createHash('sha256')
    .update(stable({ tool: call.tool, input: call.input }))
    .digest('hex')

/** Thrown inside the commit to roll it back: the call changed nothing, so it leaves no turn. Carries what the client is told. */
class NothingWritten extends Error {
  constructor(readonly result: Result) {
    super('nothing written')
  }
}

/** The client's view of what a write did. A write that changed nothing is a `NothingWritten`; the rest carry the turn and the line. */
function presentWrite(o: Outcome, line: string, turn: number | null, today: string): Result {
  const base = { record: line, turn, replayed: false }
  const nothing = (output: Record<string, unknown>) => {
    throw new NothingWritten(done(output))
  }
  switch (o.tool) {
    case 'log_movements':
      return done({
        ...base,
        movements: o.movements.map(movementView),
      } satisfies Out<'log_movements'>)
    case 'correct_movement':
      if (o.status === 'gone') throw new NothingWritten(fail('gone', line))
      if (o.status === 'unchanged') {
        return nothing({
          ...base,
          turn: null,
          changed: [],
          before: movementView(o.old),
          after: movementView(o.old),
        } satisfies Out<'correct_movement'>)
      }
      return done({
        ...base,
        changed: o.changed,
        before: movementView(o.old),
        after: movementView(o.next),
      } satisfies Out<'correct_movement'>)
    case 'delete_movement':
      if (o.status === 'gone') throw new NothingWritten(fail('gone', line))
      return done({ ...base, deleted: movementView(o.old) } satisfies Out<'delete_movement'>)
    case 'undo_last':
      if (o.status !== 'applied') throw new NothingWritten(fail(o.status, line))
      return done({
        ...base,
        undone_turn: o.turn,
        items: o.items.map((u) => undoneItem(u, today)),
      } satisfies Out<'undo_last'>)
    case 'remember_fact':
      if (o.status === 'full') throw new NothingWritten(fail('full', line))
      if (o.status === 'unchanged') {
        return nothing({
          ...base,
          turn: null,
          status: 'unchanged',
          fact: factView(o.fact),
          previous_value: null,
        } satisfies Out<'remember_fact'>)
      }
      return done({
        ...base,
        status: o.before === undefined ? 'new' : 'updated',
        fact: factView(o.fact),
        previous_value: o.before ?? null,
      } satisfies Out<'remember_fact'>)
    case 'forget_fact':
      if (o.status === 'gone') throw new NothingWritten(fail('gone', line))
      return done({ ...base, forgotten: o.facts.map(factView) } satisfies Out<'forget_fact'>)
    case 'set_reminder':
      if (o.status !== 'applied') throw new NothingWritten(fail(o.status, line))
      return done({
        ...base,
        reminder: reminderView(o.reminder, today),
      } satisfies Out<'set_reminder'>)
    case 'cancel_reminder':
      if (o.status === 'gone') throw new NothingWritten(fail('gone', line))
      return done({
        ...base,
        reminder: reminderView(o.reminder, today),
      } satisfies Out<'cancel_reminder'>)
    case 'forget_all_confirmed':
      // Not offered over MCP (it needs the person's own "sí" on WhatsApp): the registry has no `mcp` block for it.
      throw new Error('forget_all_confirmed is not an MCP tool')
  }
}

/**
 * One MCP write: the same value guards as WhatsApp (`checkValues`), then `commit` on the channel `mcp`, with the same undo (every store).
 * `request_id` makes a retry safe: under the account lock, a request seen before returns its first answer when the call is the same one
 * (tool and checked input) and a typed refusal when it is another; the request's row is stored in the turn's own transaction. A call that
 * changes nothing (a refusal, a no-op) rolls back and leaves no turn and no row, so the same id can be sent again.
 */
async function write(
  c: ToolContext,
  tool: WriteTool,
  raw: Record<string, unknown>,
): Promise<Result> {
  const { request_id: requestId, ...input } = raw as { request_id?: string }
  const now = c.now()
  const today = argentinaToday(now)
  const checked = checkValues(tool, input, { today, now })
  if (checked.kind === 'declined') return fail(checked.declined, declineLine(checked.declined))
  if (checked.kind !== 'ok' || !writes(checked.call)) {
    return fail('invalid', checked.kind === 'rejected' ? checked.message : 'invalid input')
  }
  const call = checked.call
  const hash = callHash(call)
  let early: Result | undefined
  let captured: Result | undefined
  try {
    const committed = await commit(c.sql, {
      accountId: c.accountId,
      channel: 'mcp',
      now,
      calls: [call],
      // Under the account lock (the caller's own turn takes it again, in the same transaction), before anything is written.
      before: async (tx) => {
        await lockAccount(tx, c.accountId)
        // A reminder is sent to WhatsApp: an account with no address there would hold one that is never sent.
        if (call.tool === 'set_reminder' && !(await whatsappAddress(tx, c.accountId))) {
          early = fail('no_whatsapp_address', REPLY.noWhatsappAddress)
          return false
        }
        if (requestId === undefined) return true
        const [prior] = await tx<{ input_hash: string; result: Record<string, unknown> }[]>`
          SELECT input_hash, result FROM mcp_request WHERE account_id = ${c.accountId} AND request_id = ${requestId}`
        if (!prior) return true
        // The same call gets its first answer; another call under the same id gets neither that answer nor a write.
        early =
          prior.input_hash === hash
            ? done({ ...prior.result, replayed: true })
            : fail(
                'request_id_reused',
                'request_id was already used for a different call: send a new one.',
              )
        return false
      },
      compose: (results, record) => {
        const [only] = results
        if (!only?.outcome || only.line === null) throw new Error('an MCP write has one outcome')
        captured = presentWrite(only.outcome, only.line, null, today)
        return { reply: record ?? only.line }
      },
      after: async (tx, turn) => {
        const [only] = [captured]
        if (!only) return
        // The turn id is known only now: present again with it, and store what the client was told.
        const result = withTurn(only, turn.id)
        captured = result
        if (requestId !== undefined) {
          await tx`
            INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result)
            VALUES (${c.accountId}, ${requestId}, ${hash}, ${turn.id}, ${tx.json(result.structuredContent as never)})`
        }
      },
    })
    if (committed === null) return early ?? fail('unavailable', 'nothing was written')
    return captured ?? fail('unavailable', 'nothing was written')
  } catch (error) {
    if (error instanceof NothingWritten) return error.result
    return unavailable(`warren_${tool}`, error)
  }
}

const withTurn = (r: Result, turn: number): Result => done({ ...r.structuredContent, turn })

/** One call of a tool, as the server runs it: a failure of the database is an error result without detail, never a crash. */
export async function runTool(
  c: ToolContext,
  name: Tool,
  input: Record<string, unknown>,
): Promise<Result> {
  try {
    const read = READS[name]
    return read ? await read(c, input) : await write(c, name as WriteTool, input)
  } catch (error) {
    return unavailable(`warren_${name}`, error)
  }
}

// ---- Registration

/** Every registry entry with an `mcp` block, as a tool named `warren_<tool>`. */
export function registerTools(server: McpServer, c: ToolContext) {
  for (const [name, entry] of Object.entries(COMMANDS) as [Tool, (typeof COMMANDS)[Tool]][]) {
    const block = 'mcp' in entry ? (entry.mcp as McpBlock | undefined) : undefined
    if (!block) continue
    const isWrite = entry.kind === 'write'
    const inputSchema = (entry.input as z.ZodObject).extend(block.extra ?? {})
    server.registerTool(
      `warren_${name}`,
      {
        title: block.title,
        description: `${block.description} ${isWrite ? WRITES : ''} ${QUOTE}`
          .replace(/\s+/g, ' ')
          .trim(),
        inputSchema,
        outputSchema: block.output as z.ZodObject,
        scopeChallenge: requireScopes(block.scope),
        annotations: {
          title: block.title,
          ...(isWrite
            ? {
                readOnlyHint: false,
                destructiveHint: block.destructive === true,
                idempotentHint: false,
                openWorldHint: false,
              }
            : readOnly),
        },
      },
      (input: Record<string, unknown>) => runTool(c, name, input),
    )
  }
}
