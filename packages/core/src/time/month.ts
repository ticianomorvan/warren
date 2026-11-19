/** A calendar month written "yyyy-mm", with its first and last day: all computed here (rule 1). */
export type MonthRange = { month: string; from: string; to: string }

const two = (n: number) => String(n).padStart(2, '0')

export const monthText = (year: number, month: number): string => `${year}-${two(month)}`

/** `Date.UTC` rolls month 0 and 13 into the neighbouring year, which is the arithmetic we need. */
export const shiftMonth = (year: number, month: number, by: number) => {
  const d = new Date(Date.UTC(year, month - 1 + by, 1))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export const monthRange = (year: number, month: number): MonthRange => ({
  month: monthText(year, month),
  from: `${monthText(year, month)}-01`,
  to: `${monthText(year, month)}-${two(lastDay(year, month))}`,
})

/** The shape of a month text, "2026-10". */
export const MONTH_FORMAT = /^(\d{4})-(\d{2})$/

/** "2026-10" as numbers, or null when it is not four digits, a dash and a month 01 to 12. */
export function parseMonth(text: string): { year: number; month: number } | null {
  const m = MONTH_FORMAT.exec(text)
  const year = Number(m?.[1])
  const month = Number(m?.[2])
  if (!m || month < 1 || month > 12) return null
  return { year, month }
}

const MONTH_NAMES = [
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
] as const

/** The Spanish name of a month, lowercase: `monthName(11)` is "noviembre". Undefined outside 1 to 12. */
export const monthName = (month: number): string | undefined => MONTH_NAMES[month - 1]
