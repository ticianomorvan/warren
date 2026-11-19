import { ASSETS, type Currency } from '../../assets'

/**
 * Validators for values read out of bank mail. Each returns the normalised value or throws
 * FieldError naming the field, so a layout change shows up as "schema-fail:<field>" instead of
 * a wrong entry in the books.
 */
export class FieldError extends Error {
  constructor(readonly field: string) {
    super(`invalid field: ${field}`)
  }
}

const CURRENCY_SYMBOLS: Record<string, Currency> = {
  ARS: 'ARS',
  $: 'ARS',
  USD: 'USD',
  U$S: 'USD',
  US$: 'USD',
}

/** A code after the amount, as a wallet prints it. Both spellings of Tether are USDT. */
const CURRENCY_SUFFIXES: Record<string, Currency> = { USD: 'USD', 'USD₮': 'USDT', USDT: 'USDT' }

const WHOLE = String.raw`(\d{1,3}(?:\.\d{3})*|\d+)`
const PREFIXED = new RegExp(String.raw`^(ARS|USD|U\$S|US\$|\$)\s*${WHOLE}(?:,(\d+))?$`)
const SUFFIXED = new RegExp(String.raw`^${WHOLE}(?:,(\d+))?\s*(USD₮|USDT|USD)$`)

/**
 * "ARS 1.234,56" or "$ 3,77" → { amount: "1234.56", currency: "ARS" }. Never a float. A bank
 * prints the places always. With `wallet`, the places may be left out ("$1695", which is
 * "1695.00") and the currency may follow the amount ("99,99 USD₮").
 */
export function parseMoney(
  text: string,
  field = 'amount',
  { wallet = false }: { wallet?: boolean } = {},
): { amount: string; currency: Currency } {
  const v = text.trim()
  const pre = PREFIXED.exec(v)
  const suf = wallet ? SUFFIXED.exec(v) : null
  const [whole, places, code] = pre ? [pre[2], pre[3], pre[1]] : [suf?.[1], suf?.[2], suf?.[3]]
  const currency = pre ? CURRENCY_SYMBOLS[code ?? ''] : CURRENCY_SUFFIXES[code ?? '']
  if (whole === undefined || !currency) throw new FieldError(field)
  const decimals = ASSETS[currency].decimals
  if (places === undefined ? !wallet : places.length !== decimals) throw new FieldError(field)
  const integer = whole.replaceAll('.', '').replace(/^0+(?=\d)/, '')
  return { amount: `${integer}.${places ?? '0'.repeat(decimals)}`, currency }
}

/** "14/11/2026" → "2026-11-14", rejecting impossible dates. */
export function parseDate(text: string, field = 'date'): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim())
  if (!m) throw new FieldError(field)
  const iso = `${m[3]}-${m[2]}-${m[1]}`
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new FieldError(field)
  return iso
}

/** "14/11/2026 14:09:33" → date and time to the minute, as printed (Argentina local time). */
export function parseTimestamp(text: string, field = 'date'): { date: string; time: string } {
  const m = /^(\d{2}\/\d{2}\/\d{4})\s+([01]\d|2[0-3]):([0-5]\d):[0-5]\d$/.exec(text.trim())
  if (!m) throw new FieldError(field)
  return { date: parseDate(m[1] ?? '', field), time: `${m[2]}:${m[3]}` }
}

/** "14/11/2026 - 14:09" → date and time as printed (Argentina local time). */
export function parseDateTime(text: string, field = 'date'): { date: string; time: string } {
  const m = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (!m) throw new FieldError(field)
  return { date: parseDate(m[1] ?? '', field), time: `${m[2]}:${m[3]}` }
}

function checkDigit(digits: string, weights: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++)
    sum += Number(digits[i]) * (weights[i % weights.length] ?? 0)
  return (10 - (sum % 10)) % 10
}

/** A CBU or CVU: 22 digits with two check digits. */
export function parseCbu(text: string, field = 'cbu'): string {
  const v = text.trim()
  if (!/^\d{22}$/.test(v)) throw new FieldError(field)
  const ok =
    checkDigit(v.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(v[7]) &&
    checkDigit(v.slice(8, 21), [3, 9, 7, 1]) === Number(v[21])
  if (!ok) throw new FieldError(field)
  return v
}

/** A CUIT or CUIL: 11 digits with a mod-11 check digit. */
export function parseCuit(text: string, field = 'cuit'): string {
  const v = text.trim().replaceAll('-', '')
  if (!/^\d{11}$/.test(v)) throw new FieldError(field)
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(v[i]) * (weights[i] ?? 0)
  const mod = 11 - (sum % 11)
  const expected = mod === 11 ? 0 : mod === 10 ? 9 : mod
  if (expected !== Number(v[10])) throw new FieldError(field)
  return v
}

/** Digits only, bounded length (bank reference numbers). */
export function parseDigits(text: string, field: string, min = 4, max = 30): string {
  const v = text.trim()
  if (!new RegExp(`^\\d{${min},${max}}$`).test(v)) throw new FieldError(field)
  return v
}

/** Free text written by a person or a bank list: kept as data, bounded, single line. */
export function parseText(text: string, field: string, max = 120): string {
  const v = text.replace(/\s+/g, ' ').trim()
  if (v.length === 0 || v.length > max) throw new FieldError(field)
  return v
}

/** The Argentine calendar date (UTC-3, no DST) of an instant, YYYY-MM-DD. */
export const argentinaDate = (instant: Date): string =>
  new Date(instant.getTime() - 3 * 3600_000).toISOString().slice(0, 10)

/** Whole days between an ISO date and an instant, both read in Argentina time (UTC-3, no DST). */
export function daysFromInstant(isoDate: string, instant: Date): number {
  const local = argentinaDate(instant)
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${local}T00:00:00Z`)) / 86_400_000,
  )
}
