/** The subjects a principle or fact can be filed under. Adding one is a deliberate change. */
export const TOPICS = [
  'emergency-fund',
  'liquidity',
  'savings',
  'debt',
  'cards',
  'inflation',
  'currency',
  'fx',
  'rates',
  'deposits',
  'diversification',
  'investing',
  'insurance',
  'purchases',
  'income-risk',
  'taxes',
  'compliance',
  'pensions',
  'scams',
  'professional',
] as const

export type Topic = (typeof TOPICS)[number]

/** Who the person is sent to for what the facts cannot settle. */
export const PROFESSIONALS = ['contador', 'asesor', 'abogado', 'productor de seguros'] as const

export type Professional = (typeof PROFESSIONALS)[number]

/** A durable rule of personal finance, translated into Argentine terms. */
export type Principle = {
  id: string
  title: string
  body: string
  applies_to: Topic[]
}

/** A known scam or bad-advice pattern, and what a person can check or do about it. */
export type Trap = {
  id: string
  title: string
  signs: string[]
  what_to_do: string
}

/** A dated, sourced fact. Dates are yyyy-mm-dd. */
export type Fact = {
  id: string
  topic: Topic
  statement: string
  /** Decimal string, when the fact is one number. */
  value?: string
  unit?: string
  /** Further named amounts, for a fact that is a table or a list rather than one number. */
  parts?: { label: string; value: string; unit: string }[]
  /** The day the value was read from its source. */
  as_of: string
  /** The day after which the value must be checked again. */
  review_by: string
  /** `slow`: a regulatory figure that changes on a schedule. `moving`: a market or index value. */
  volatility: 'slow' | 'moving'
  source_url: string
  source_name: string
  needs_professional?: Professional
}
