/**
 * The assets a ledger can hold, by the code a movement stores. `decimals` is how many places a
 * mail prints; `symbol` is what a notice writes before the amount. A later asset is a row here.
 */
export const ASSETS = {
  ARS: { decimals: 2, symbol: '$' },
  USD: { decimals: 2, symbol: 'US$' },
  USDT: { decimals: 2, symbol: 'USDT' },
} as const satisfies Record<string, { decimals: number; symbol: string }>

export type Currency = keyof typeof ASSETS

export const isAsset = (code: string): code is Currency => Object.hasOwn(ASSETS, code)
