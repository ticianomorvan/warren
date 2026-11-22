import { canonical } from '../../src/agent/say'
import { formatMoney } from '../../src/render'
import type { NewMovementExpect, ReminderExpect, Turn } from './schema'

/** One movement row of the account in any state, as read from the database after a turn. */
export interface Row {
  id: number
  amount: string
  date: string
  description: string
  category: string
  payment: string | null
  direction: 'in' | 'out'
  currency: 'ARS' | 'USD'
  supersededBy: number | null
  deleted: boolean
}

export const isLive = (r: Row) => r.supersededBy === null && !r.deleted

/** What the grader needs to know about one turn. */
export interface TurnInput {
  turn: Turn
  /** The Argentine day of the turn. */
  today: string
  /** Every movement of the account (any state) before and after the turn. */
  before: Row[]
  after: Row[]
  /** Scenario ref -> id of the live movement it stands for, before the turn. */
  refs: ReadonlyMap<string, number>
  reply: string
  /** The reply is the failure notice: the message did not reach the commit point. */
  failed: boolean
  /** The command that ran (`query` replies hold sums, which the ledger check cannot vouch for). */
  commandType: string | null
  /** How many live facts the person has after the turn (agent slice F); the turn's `liveFacts` is checked against it. */
  liveFacts?: number
  /** The person's live reminders after the turn: what, next date (Argentine local `yyyy-mm-ddThh:mm`) and the stored schedule. */
  liveReminders?: LiveReminder[]
}

/** A live reminder as read from the database. */
export interface LiveReminder {
  what: string
  first: string | null
  schedule: Record<string, unknown>
}

export interface TurnGrade {
  ok: boolean
  /** Why it is not ok, one line each. */
  problems: string[]
  /** The ledger got a write the scenario does not allow: a wrong row ended, a wrong value, an extra row. */
  wrongWrite: boolean
  /** The reply says it worked (starts with ✓, ↩︎ or 🧠). */
  claimsSuccess: boolean
  /** A wrong write under a reply that claims success. Must never happen. */
  silentWrong: boolean
  asked: boolean
  /** Something was expected to change, nothing did, and the reply is a question. */
  unnecessaryQuestion: boolean
  ledgerChanged: boolean
  /** Money amounts in the reply that no movement of the account has. */
  invented: string[]
  /** Refs after the turn (a corrected movement keeps its ref; a deleted one is dropped). */
  refs: Map<string, number>
}

export const norm = (text: string | null | undefined) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()

const looseText = (actual: string, expected: string) => {
  const a = norm(actual)
  const e = norm(expected)
  return a === e || a.includes(e) || e.includes(a)
}

const samePayment = (actual: string | null, expected: string | null) =>
  expected === null || actual === null
    ? expected === actual
    : norm(actual).includes(norm(expected)) || norm(expected).includes(norm(actual))

const sameAmount = (a: string, b: string) => Number(a) === Number(b)

interface Fields {
  amount: string
  date: string
  description: string
  /** Not checked when undefined (a new movement whose category the scenario does not pin). */
  category: string | undefined
  payment: string | null
  direction: 'in' | 'out'
  currency: 'ARS' | 'USD'
  /** A correction keeps the description exactly unless it sets one: compare strictly then. */
  strictDescription: boolean
}

/** Differences between an actual row and what was expected; empty when it matches. */
function diff(row: Row, e: Fields): string[] {
  const out: string[] = []
  if (!sameAmount(row.amount, e.amount)) out.push(`amount ${row.amount}, expected ${e.amount}`)
  if (row.date !== e.date) out.push(`date ${row.date}, expected ${e.date}`)
  const description = e.strictDescription
    ? norm(row.description) === norm(e.description)
    : looseText(row.description, e.description)
  if (!description) out.push(`description "${row.description}", expected "${e.description}"`)
  if (e.category !== undefined && row.category !== e.category) {
    out.push(`category ${row.category}, expected ${e.category}`)
  }
  if (!samePayment(row.payment, e.payment)) {
    out.push(`payment ${row.payment ?? 'null'}, expected ${e.payment ?? 'null'}`)
  }
  if (row.direction !== e.direction) out.push(`direction ${row.direction}, expected ${e.direction}`)
  if (row.currency !== e.currency) out.push(`currency ${row.currency}, expected ${e.currency}`)
  return out
}

const describe = (r: Row) => `#${r.id} ${r.description} ${r.amount} (${r.date})`

/** Money tokens in a reply: `$3.500`, `$8.500,50`, `US$ 50`. */
export function moneyTokens(reply: string): string[] {
  const found = reply.match(/US\$ ?\d[\d.]*(?:,\d+)?|(?<!US)\$\d[\d.]*(?:,\d+)?/g) ?? []
  return found.map((t) => t.replace(/\.+$/, ''))
}

/** A money token as `formatMoney` writes it, so "$5000" and "$5.000" are the same amount (the value is what counts). */
const asWritten = (token: string) =>
  formatMoney(canonical(token.replace(/[^\d.,]/g, '')), token.startsWith('US') ? 'USD' : 'ARS')

/** The reply without the 🎙️ line a voice note's answer may start with: a question is judged by what follows it. */
export const withoutHeard = (reply: string) => reply.replace(/^🎙️ "[^\n]*"\n/, '')

export function gradeTurn(input: TurnInput): TurnGrade {
  const { turn, today, before, after, refs, reply } = input
  const problems: string[] = []
  const beforeLive = before.filter(isLive)
  const beforeLiveIds = new Set(beforeLive.map((r) => r.id))
  const byId = new Map(before.map((r) => [r.id, r]))
  const afterById = new Map(after.map((r) => [r.id, r]))

  // What the turn is allowed and required to do.
  const endedExpected = new Map<number, 'superseded' | 'deleted'>()
  const logsExpected: NewMovementExpect[] = []
  const correctionsExpected: { id: number; ref: string; fields: Fields }[] = []
  for (const op of turn.ops) {
    if (op.op === 'log') {
      logsExpected.push(...op.movements)
      continue
    }
    const id = refs.get(op.ref)
    const old = id === undefined ? undefined : byId.get(id)
    if (id === undefined || !old || !beforeLiveIds.has(id)) {
      throw new Error(`scenario bug: ref "${op.ref}" is not a live movement at this turn`)
    }
    if (op.op === 'delete') {
      endedExpected.set(id, 'deleted')
      continue
    }
    const s = op.set
    endedExpected.set(id, 'superseded')
    correctionsExpected.push({
      id,
      ref: op.ref,
      fields: {
        amount: s.amount ?? old.amount,
        date: s.date ?? old.date,
        description: s.description ?? old.description,
        category: s.category ?? old.category,
        payment: s.payment === undefined ? old.payment : s.payment,
        direction: s.direction ?? old.direction,
        currency: s.currency ?? old.currency,
        strictDescription: s.description === undefined,
      },
    })
  }

  // What happened.
  const actualEnded = beforeLive.filter((r) => {
    const now = afterById.get(r.id)
    return now !== undefined && !isLive(now)
  })
  const actualNew = after.filter((r) => isLive(r) && !beforeLiveIds.has(r.id))
  const ledgerChanged = actualEnded.length > 0 || actualNew.length > 0
  let wrongWrite = false

  for (const r of actualEnded) {
    const now = afterById.get(r.id) as Row
    const kind = now.deleted ? 'deleted' : 'superseded'
    const want = endedExpected.get(r.id)
    if (want === undefined) {
      wrongWrite = true
      problems.push(`${kind} ${describe(r)}, which must stay as it was`)
    } else if (want !== kind) {
      wrongWrite = true
      problems.push(`${describe(r)} was ${kind}, expected ${want}`)
    }
  }
  for (const [id, want] of endedExpected) {
    const now = afterById.get(id)
    if (now && isLive(now)) problems.push(`${describe(byId.get(id) as Row)} should be ${want}`)
  }

  // New rows: the successor of each corrected movement, then the logged ones.
  const free = new Set(actualNew.map((r) => r.id))
  const successor = (id: number) =>
    actualNew.find((r) => r.supersededBy === null && predecessorOf(r, after) === id)
  const newRefs = new Map(refs)
  for (const c of correctionsExpected) {
    const row = successor(c.id)
    if (!row) {
      if (
        endedExpected.get(c.id) === 'superseded' &&
        !problems.some((p) => p.includes(`#${c.id} `))
      ) {
        problems.push(`no corrected row for ${describe(byId.get(c.id) as Row)}`)
      }
      continue
    }
    free.delete(row.id)
    const d = diff(row, c.fields)
    if (d.length > 0) {
      wrongWrite = true
      problems.push(`correction of ${describe(byId.get(c.id) as Row)}: ${d.join('; ')}`)
    }
    newRefs.set(c.ref, row.id)
  }
  for (const c of correctionsExpected) {
    const now = afterById.get(c.id)
    if (now && !isLive(now) && !successor(c.id)) newRefs.delete(c.ref)
  }

  const logRows = actualNew.filter((r) => free.has(r.id))
  const unmatched: NewMovementExpect[] = []
  for (const e of logsExpected) {
    const fields: Fields = {
      amount: e.amount,
      date: e.date ?? today,
      description: e.description,
      category: e.category,
      payment: e.payment,
      direction: e.direction,
      currency: e.currency,
      strictDescription: false,
    }
    const k = logRows.findIndex((r) => free.has(r.id) && diff(r, fields).length === 0)
    const hit = logRows[k]
    if (hit) {
      free.delete(hit.id)
      if (e.ref) newRefs.set(e.ref, hit.id)
    } else unmatched.push(e)
  }
  const extra = logRows.filter((r) => free.has(r.id))
  for (const r of extra) {
    wrongWrite = true
    problems.push(`unexpected new movement ${describe(r)}${r.payment ? ` (${r.payment})` : ''}`)
  }
  for (const e of unmatched) {
    problems.push(`missing movement ${e.description} ${e.amount} ${e.currency}`)
  }
  // A deleted ref is gone; a refless ended row cannot be addressed again.
  for (const [ref, id] of newRefs) {
    const now = afterById.get(id)
    if (now && !isLive(now)) newRefs.delete(ref)
  }

  // The reply.
  const text = withoutHeard(reply).trim()
  const claimsSuccess =
    text.startsWith('✓') || text.startsWith('↩︎') || text.startsWith('🧠') || text.startsWith('⏰')
  const asked = text.startsWith('¿')
  const flat = norm(reply)
  if (input.failed) problems.push('the message failed (failure notice)')
  for (const s of turn.reply.has) if (!flat.includes(norm(s))) problems.push(`reply lacks "${s}"`)
  if (turn.reply.any.length > 0 && !turn.reply.any.some((s) => flat.includes(norm(s)))) {
    problems.push(`reply has none of: ${turn.reply.any.map((s) => `"${s}"`).join(', ')}`)
  }
  for (const s of turn.reply.not) if (flat.includes(norm(s))) problems.push(`reply has "${s}"`)
  if (turn.reply.re && !new RegExp(turn.reply.re, 'i').test(reply)) {
    problems.push(`reply does not match /${turn.reply.re}/`)
  }
  if (turn.ask && !asked) problems.push('the reply should be a question')
  if (turn.liveFacts !== undefined && input.liveFacts !== turn.liveFacts) {
    problems.push(`${input.liveFacts ?? 'unknown'} live facts, expected ${turn.liveFacts}`)
  }
  // Reminders: the live ones must be exactly those the turn lists. A wrong one under a reply that says it worked is a silent wrong change.
  let reminderWrong = false
  if (turn.liveReminders !== undefined) {
    const found = reminderProblems(turn.liveReminders, input.liveReminders ?? [])
    problems.push(...found)
    reminderWrong = found.length > 0
  }
  const unnecessaryQuestion = turn.ops.length > 0 && asked && !ledgerChanged
  if (unnecessaryQuestion) problems.push('asked a question instead of acting')

  // Numbers: every amount in a reply must come from a movement (queries hold sums: their text is checked by `has`).
  // An amount is not invented when a movement has it or the person wrote it in this message (the
  // model may quote their own figure back; every figure it did not get from code is refused earlier).
  const known = new Set(after.map((r) => formatMoney(r.amount, r.currency)))
  for (const [token] of turn.text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    for (const currency of ['ARS', 'USD'] as const)
      known.add(formatMoney(canonical(token), currency))
  }
  const invented =
    input.commandType === 'query'
      ? []
      : moneyTokens(reply).filter(
          (t) =>
            !known.has(t) && !known.has(asWritten(t)) && !turn.reply.has.some((s) => s.includes(t)),
        )
  if (invented.length > 0) problems.push(`amounts not in the ledger: ${invented.join(', ')}`)

  return {
    ok: problems.length === 0,
    problems,
    wrongWrite,
    claimsSuccess,
    silentWrong: (wrongWrite || reminderWrong) && claimsSuccess,
    asked,
    unnecessaryQuestion,
    ledgerChanged,
    invented,
    refs: newRefs,
  }
}

const sameField = (actual: unknown, expected: unknown) =>
  Array.isArray(expected) && Array.isArray(actual)
    ? JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
    : JSON.stringify(actual) === JSON.stringify(expected)

/** What differs between the reminders a turn expects and the live ones: each expected one must match a distinct live one. */
export function reminderProblems(expected: ReminderExpect[], live: LiveReminder[]): string[] {
  const free = new Set(live.keys())
  const problems: string[] = []
  for (const e of expected) {
    const k = [...free].find((i) => {
      const r = live[i] as LiveReminder
      return (
        looseText(r.what, e.what) &&
        (e.first === undefined || r.first === e.first) &&
        Object.entries(e.schedule ?? {}).every(([key, value]) => sameField(r.schedule[key], value))
      )
    })
    if (k === undefined)
      problems.push(`missing reminder "${e.what}"${e.first ? ` at ${e.first}` : ''}`)
    else free.delete(k)
  }
  for (const i of free) {
    const r = live[i] as LiveReminder
    problems.push(`unexpected reminder "${r.what}" at ${r.first} ${JSON.stringify(r.schedule)}`)
  }
  return problems
}

/** The movement a row replaced, if any. */
function predecessorOf(row: Row, all: Row[]): number | null {
  return all.find((r) => r.supersededBy === row.id)?.id ?? null
}
