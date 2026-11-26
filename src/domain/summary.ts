/**
 * The arithmetic of a comparison. Pure, on decimal strings through integer cents (`bigint`): no float ever
 * touches money, so a difference and a percentage are exact and the same everywhere they are shown.
 */

/** "12000" -> 1200000n, "4500.5" -> 450050n. Amounts have at most 2 decimals (`validateCommand` and the column). */
export function toCents(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.')
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) {
    throw new Error(`not an amount with at most 2 decimals: ${amount}`)
  }
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

/** The decimal string of cents, as `formatMoney` expects it: "1200000" -> "12000", "450050" -> "4500.50". */
export function fromCents(cents: bigint): string {
  const whole = cents / 100n
  const fraction = cents % 100n
  return fraction === 0n ? `${whole}` : `${whole}.${String(fraction).padStart(2, '0')}`
}

export interface Change {
  /** Which way `current` went from `previous`. */
  way: 'more' | 'less' | 'same'
  /** The size of the difference, never negative, as a decimal string. */
  amount: string
  /**
   * How much of `previous` the difference is, in tenths of a percent (a signed integer, rounded half away from
   * zero): 205 is +20,5%. Null when there is nothing before to compare with: a division by zero is never made.
   */
  tenths: bigint | null
}

/** `current` against `previous`, both decimal strings. */
export function change(current: string, previous: string): Change {
  const now = toCents(current)
  const before = toCents(previous)
  const delta = now - before
  const size = delta < 0n ? -delta : delta
  const way = delta === 0n ? 'same' : delta > 0n ? 'more' : 'less'
  if (before === 0n) return { way, amount: fromCents(size), tenths: null }
  // |delta| / previous in tenths of a percent, rounded half up on the size, then signed.
  const rounded = (size * 1000n * 2n + before) / (before * 2n)
  return { way, amount: fromCents(size), tenths: delta < 0n ? -rounded : rounded }
}

/** "+20%", "-5,5%", "0%" from tenths of a percent (Argentine decimal comma). */
export function formatPercent(tenths: bigint): string {
  if (tenths === 0n) return '0%'
  const size = tenths < 0n ? -tenths : tenths
  const whole = size / 10n
  const decimal = size % 10n
  return `${tenths < 0n ? '-' : '+'}${whole}${decimal === 0n ? '' : `,${decimal}`}%`
}
