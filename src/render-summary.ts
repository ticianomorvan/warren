import type { Category, GroupBy } from './agent/schema'
import type { GroupTotal, QueryTotal } from './ledger'
import type { Resolved } from './range'
import { CATEGORY_LABEL, capitalize, formatMoney } from './render'
import { change, formatPercent, toCents } from './summary'
import { addDays, weekdayName } from './time'

/**
 * The reply to a summary, from SQL results and nothing else: every figure here is a sum or a count the database
 * made, or a difference or a percentage `summary.ts` computed from two of them. Pure. The wording is plain on
 * purpose (Ticiano will refine it); what it must always do is name the days it covers and keep currencies and
 * directions apart.
 */

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]
const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
]

/** The most groups listed of what was bought or paid; the rest are "… y N más". */
export const MAX_GROUPS = 8
/** The most days, weeks or months listed; when there are more, the newest are kept and the older are counted. */
export const MAX_BUCKETS = 31

export interface SummaryScope {
  direction: 'in' | 'out' | null
  category: Category | null
  payment: string | null
  /** Words of the description the totals are about ("café"). */
  description: string | null
  groupBy: GroupBy
}

/** One range with what the database found in it. */
export interface Side {
  range: Resolved
  totals: QueryTotal[]
  groups: GroupTotal[]
}

const parts = (day: string) => day.split('-').map(Number) as [number, number, number]
const month = (m: number) => MONTHS_SHORT[m - 1] ?? ''
const movements = (n: number) => `${n} ${n === 1 ? 'movimiento' : 'movimientos'}`
const mondayOf = (day: string) =>
  addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))

/** "9–15 nov", "28 oct–3 nov", "5 nov"; the year is added when a day is not of the current year. */
export function spanText(from: string, to: string, today: string): string {
  const [fy, fm, fd] = parts(from)
  const [ty, tm, td] = parts(to)
  const current = parts(today)[0]
  const year = (y: number) => (fy !== current || ty !== current ? ` ${y}` : '')
  if (from === to) return `${fd} ${month(fm)}${year(fy)}`
  if (fy !== ty) return `${fd} ${month(fm)} ${fy}–${td} ${month(tm)} ${ty}`
  if (fm === tm) return `${fd}–${td} ${month(tm)}${year(ty)}`
  return `${fd} ${month(fm)}–${td} ${month(tm)}${year(ty)}`
}

/** The range in words, as the first thing a summary says: "Octubre (1–31)", "Semana pasada (9–15 nov)". */
export function rangeLabel(r: Resolved, today: string): string {
  const [fy, fm, fd] = parts(r.from)
  const [, , td] = parts(r.to)
  const open = r.partial ? ', en curso' : ''
  const current = parts(today)[0]
  switch (r.kind) {
    case 'day':
      return r.from === today
        ? `Hoy (${spanText(r.from, r.to, today)})`
        : r.from === addDays(today, -1)
          ? `Ayer (${spanText(r.from, r.to, today)})`
          : `El ${spanText(r.from, r.to, today)}`
    case 'week': {
      const name =
        r.from === mondayOf(today)
          ? 'Esta semana'
          : r.from === addDays(mondayOf(today), -7)
            ? 'Semana pasada'
            : 'Semana'
      return `${name} (${spanText(r.from, r.to, today)}${open})`
    }
    case 'weekend':
      return `Fin de semana (${spanText(r.from, r.to, today)}${open})`
    case 'month':
      return `${capitalize(MONTHS[fm - 1] ?? '')}${fy === current ? '' : ` ${fy}`} (${fd}–${td}${open})`
    case 'year':
      return `Año ${fy} (${spanText(r.from, r.to, today)}${open})`
    case 'custom': {
      if (r.from === r.to) return `El ${spanText(r.from, r.to, today)}`
      return `Del ${spanText(r.from, r.to, today).replace('–', ' al ')}`
    }
  }
}

/** One group's name: a category, a payment as written, a day, the week of a Monday or a month. */
function groupLabel(by: GroupBy, g: GroupTotal, today: string): string {
  if (by === 'category') return CATEGORY_LABEL[g.key as Category] ?? g.key
  if (by === 'payment') return g.label ? capitalize(g.label) : 'Sin medio de pago'
  if (by === 'none') return ''
  // A day, the Monday of a week (yyyy-mm-dd) or a month (yyyy-mm).
  const [y, m, d] = parts(by === 'month' ? `${g.key}-01` : g.key)
  const other = y !== parts(today)[0]
  const date = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}${other ? `/${String(y).slice(2)}` : ''}`
  if (by === 'day') return `${weekdayName(g.key).slice(0, 3)} ${date}`
  if (by === 'week') return `Semana del ${date}`
  return `${capitalize(MONTHS[m - 1] ?? '')}${other ? ` ${y}` : ''}`
}

const TITLE: Record<GroupBy, string> = {
  none: '',
  category: 'Por categoría:',
  payment: 'Por medio de pago:',
  day: 'Por día:',
  week: 'Por semana:',
  month: 'Por mes:',
}

interface Pair {
  direction: 'in' | 'out'
  currency: 'ARS' | 'USD'
}
const same = (a: Pair, b: Pair) => a.direction === b.direction && a.currency === b.currency
const byPair = (a: Pair, b: Pair) =>
  (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1) ||
  a.currency.localeCompare(b.currency)

const bigger = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0)

/**
 * The reply to a summary: one block per direction and currency (out first, ARS first), never added together.
 * With `previous` it shows both totals and the difference of each block, from `summary.change`, and says so when
 * there is nothing before to compare with.
 */
export function renderSummary(
  scope: SummaryScope,
  today: string,
  current: Side,
  previous: Side | null,
): string {
  const label = rangeLabel(current.range, today)
  const before = previous ? rangeLabel(previous.range, today) : ''
  const payment = scope.payment?.trim()
  const about = [
    scope.category ? CATEGORY_LABEL[scope.category] : '',
    scope.description?.trim().toLowerCase() ?? '',
  ].filter(Boolean)
  const filter = `${about.length > 0 ? ` en ${about.join(', ')}` : ''}${payment ? ` con ${payment}` : ''}`
  const noun = (direction: 'in' | 'out' | null) =>
    direction === 'out' ? 'gastos' : direction === 'in' ? 'ingresos' : 'movimientos'

  const pairs: Pair[] = []
  for (const t of [...current.totals, ...(previous?.totals ?? [])]) {
    if (!pairs.some((p) => same(p, t))) pairs.push({ direction: t.direction, currency: t.currency })
  }
  pairs.sort(byPair)
  if (pairs.length === 0) {
    return previous
      ? `No encontré ${noun(scope.direction)}${filter} en ${label} ni en ${before}.`
      : `${label}: no encontré ${noun(scope.direction)}${filter}.`
  }

  const totalOf = (side: Side, p: Pair) => side.totals.find((t) => same(t, p))
  const groupsOf = (side: Side, p: Pair) => side.groups.filter((g) => same(g, p))
  const head = (name: string, p: Pair, t: QueryTotal | undefined, first: boolean) => {
    if (!t) return `${name}: no hay ${noun(p.direction)}${filter}.`
    const money = formatMoney(t.total, t.currency)
    const verb = p.direction === 'out' ? 'gastaste' : 'cobraste'
    return first
      ? `${name} ${verb} ${money}${filter} (${movements(t.count)}).`
      : `Y ${money} (${movements(t.count)}).`
  }

  const blocks = pairs.map((p, k) => {
    const first = !pairs.slice(0, k).some((o) => o.direction === p.direction)
    const now = totalOf(current, p)
    if (!previous) {
      return [head(label, p, now, first), ...listGroups(scope.groupBy, groupsOf(current, p), today)]
    }
    const was = totalOf(previous, p)
    return [
      head(label, p, now, true),
      head(before, p, was, true),
      compareLine(p, now, was, before),
      ...compareGroups(scope.groupBy, groupsOf(current, p), groupsOf(previous, p), p, today),
    ]
  })
  return blocks.flat().join('\n')
}

/** The line that says how the range compares with the one before, or why it cannot. */
function compareLine(
  p: Pair,
  now: QueryTotal | undefined,
  was: QueryTotal | undefined,
  before: string,
): string {
  const nouns = p.direction === 'out' ? 'gastos' : 'ingresos'
  if (!was) return `No hay ${nouns} en ${before} para comparar.`
  const c = change(now?.total ?? '0', was.total)
  if (c.way === 'same') return 'Diferencia: ninguna.'
  const percent = c.tenths === null ? '' : ` (${formatPercent(c.tenths)})`
  return `Diferencia: ${formatMoney(c.amount, p.currency)} ${c.way === 'more' ? 'más' : 'menos'}${percent}.`
}

/** The groups of one block: what was bought or paid, biggest first and cut at `MAX_GROUPS`; days, weeks or months in order. */
function listGroups(by: GroupBy, groups: GroupTotal[], today: string): string[] {
  if (by === 'none' || groups.length === 0) return []
  const timed = by === 'day' || by === 'week' || by === 'month'
  const cap = timed ? MAX_BUCKETS : MAX_GROUPS
  const shown = timed ? groups.slice(-cap) : groups.slice(0, cap)
  const hidden = groups.length - shown.length
  const rows = shown.map(
    (g) =>
      `• ${groupLabel(by, g, today)} ${formatMoney(g.total, g.currency)} (${movements(g.count)})`,
  )
  return [
    TITLE[by],
    ...(hidden > 0 && timed ? [`• … y ${hidden} anteriores`] : []),
    ...rows,
    ...(hidden > 0 && !timed ? [`• … y ${hidden} más`] : []),
  ]
}

/** The same groups of two ranges side by side, "$A vs $B (+20%)", ranked by the range asked about. */
function compareGroups(
  by: GroupBy,
  now: GroupTotal[],
  was: GroupTotal[],
  p: Pair,
  today: string,
): string[] {
  if (by === 'none' || (now.length === 0 && was.length === 0)) return []
  const keys = [...new Set([...now.map((g) => g.key), ...was.map((g) => g.key)])]
  const cents = (list: GroupTotal[], key: string) => {
    const g = list.find((x) => x.key === key)
    return g ? toCents(g.total) : 0n
  }
  keys.sort(
    (a, b) =>
      bigger(cents(now, a), cents(now, b)) ||
      bigger(cents(was, a), cents(was, b)) ||
      a.localeCompare(b),
  )
  const shown = keys.slice(0, MAX_GROUPS)
  const rows = shown.map((key) => {
    const a = now.find((g) => g.key === key)
    const b = was.find((g) => g.key === key)
    const named = (a ?? b) as GroupTotal
    const c = change(a?.total ?? '0', b?.total ?? '0')
    const percent = b && c.tenths !== null ? ` (${formatPercent(c.tenths)})` : ''
    return `• ${groupLabel(by, named, today)} ${formatMoney(a?.total ?? '0', p.currency)} vs ${formatMoney(b?.total ?? '0', p.currency)}${percent}`
  })
  const hidden = keys.length - shown.length
  return [TITLE[by], ...rows, ...(hidden > 0 ? [`• … y ${hidden} más`] : [])]
}
