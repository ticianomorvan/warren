/*
 * A person's financial profile: what they earn, what they are saving for, what they owe each
 * month, and the limits they set on risk. Edited on the /profile page, read by the agent through
 * `profile_get`; both go through `parseProfile`, so they cannot disagree on what a profile is.
 * Field names are English (an agent reads them); amounts are decimal strings (rule 1).
 * No dependency: core's import allow-list has no schema library, and this shape is small.
 */

export const PROFILE_CURRENCIES = ['ARS', 'USD'] as const
export type ProfileCurrency = (typeof PROFILE_CURRENCIES)[number]

/**
 * Bounds on every list and string, so a profile stays small enough to read in one tool result.
 *
 * Tightening one is safe for the data but not free: rows saved under the old bound are re-checked
 * when read (`latestProfile`), and one that fails is reported as unreadable instead of thrown, so
 * the page shows an empty form and `profile_get` says the stored profile is invalid. The person's
 * next save becomes the latest version and replaces it. Nothing is ever migrated in place.
 */
export const PROFILE_LIMITS = {
  goals: 20,
  obligations: 50,
  name: 80,
  /** Digits before the point: ten trillion at most, far beyond any real balance, so a sum can't overflow. */
  integerDigits: 13,
  emergencyMonths: 60,
} as const

export type ProfileGoal = {
  name: string
  /** Decimal string, positive, at most 2 decimals. */
  target: string
  currency: ProfileCurrency
  /** yyyy-mm-dd: when the person wants to have it. */
  date: string
}

export type ProfileObligation = {
  name: string
  /** Decimal string, positive, at most 2 decimals: what it costs each month. */
  amount: string
  currency: ProfileCurrency
  /** Day of the month it is due (1 to 31), when it has one. */
  due_day?: number
}

/**
 * What the person says they will not do with their money, both optional. These two are the
 * limits the first advice needs: the emergency fund is the first principle, and the share held in
 * dollars is the currency-mismatch one. More come when an answer needs them.
 */
export type ProfileRiskLimits = {
  /** Months of expenses to keep liquid before anything else (0 to 60). */
  emergency_months?: number
  /** The most they accept holding in dollars, as a whole percent of savings (0 to 100). */
  max_share_in_usd?: number
}

export type Profile = {
  /** Decimal string, positive, at most 2 decimals; in `currency`. */
  monthly_income?: string
  /** The currency of `monthly_income`. */
  currency: ProfileCurrency
  goals: ProfileGoal[]
  obligations: ProfileObligation[]
  risk_limits: ProfileRiskLimits
}

export type ProfileIssueCode =
  | 'required'
  | 'too_long'
  | 'too_many'
  | 'amount'
  | 'currency'
  | 'date'
  | 'day'
  | 'whole_number'
  | 'out_of_range'

/** What is wrong and where: `path` is dotted, like `goals.0.target` or `risk_limits.emergency_months`. */
export type ProfileIssue = { path: string; code: ProfileIssueCode }

export type ProfileResult = { ok: true; profile: Profile } | { ok: false; issues: ProfileIssue[] }

const AMOUNT = new RegExp(`^(0|[1-9]\\d{0,${PROFILE_LIMITS.integerDigits - 1}})(\\.\\d{1,2})?$`)
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** True for a positive decimal string with at most two decimals, as `"1500"` or `"1500.50"`. */
function isAmount(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT.test(value) && /[1-9]/.test(value)
}

/**
 * A money input as the profile takes it: a positive decimal string with at most two decimals and
 * at most thirteen integer digits. Returns it unchanged, or null. Other amounts use this too.
 */
export const parseAmount = (value: unknown): string | null => (isAmount(value) ? value : null)

/** True for a real calendar day written yyyy-mm-dd, from the year 2000. */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DAY.exec(value)
  if (!m || Number(m[1]) < 2000) return false
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    .toISOString()
    .startsWith(value)
}

const isCurrency = (v: unknown): v is ProfileCurrency =>
  (PROFILE_CURRENCIES as readonly unknown[]).includes(v)

/** Validates a profile and returns it clean: only the known fields, names trimmed. Never throws. */
export function parseProfile(input: unknown): ProfileResult {
  const issues: ProfileIssue[] = []
  const bad = (path: string, code: ProfileIssueCode) => issues.push({ path, code })
  const root = isRecord(input) ? input : {}

  const name = (value: unknown, path: string): string => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') bad(path, 'required')
    else if ([...text].length > PROFILE_LIMITS.name) bad(path, 'too_long')
    return text
  }
  const amount = (value: unknown, path: string): string => {
    if (!isAmount(value)) bad(path, 'amount')
    return String(value)
  }
  const currency = (value: unknown, path: string): ProfileCurrency => {
    if (!isCurrency(value)) bad(path, 'currency')
    return value as ProfileCurrency
  }
  const list = (value: unknown, path: string, max: number): unknown[] => {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      bad(path, 'required')
      return []
    }
    if (value.length > max) {
      bad(path, 'too_many')
      return []
    }
    return value
  }
  const whole = (value: unknown, path: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) bad(path, 'whole_number')
    else if (value < min || value > max) bad(path, 'out_of_range')
    return value as number
  }

  const profileCurrency = currency(root.currency, 'currency')
  const monthlyIncome =
    root.monthly_income === undefined ? undefined : amount(root.monthly_income, 'monthly_income')

  const goals = list(root.goals, 'goals', PROFILE_LIMITS.goals).map((raw, i): ProfileGoal => {
    const g = isRecord(raw) ? raw : {}
    const at = `goals.${i}`
    const goal = {
      name: name(g.name, `${at}.name`),
      target: amount(g.target, `${at}.target`),
      currency: currency(g.currency, `${at}.currency`),
      date: String(g.date),
    }
    if (!isDay(g.date)) bad(`${at}.date`, 'date')
    return goal
  })

  const obligations = list(root.obligations, 'obligations', PROFILE_LIMITS.obligations).map(
    (raw, i): ProfileObligation => {
      const o = isRecord(raw) ? raw : {}
      const at = `obligations.${i}`
      const obligation: ProfileObligation = {
        name: name(o.name, `${at}.name`),
        amount: amount(o.amount, `${at}.amount`),
        currency: currency(o.currency, `${at}.currency`),
      }
      if (o.due_day !== undefined) {
        const day = o.due_day
        if (typeof day !== 'number' || !Number.isInteger(day)) bad(`${at}.due_day`, 'day')
        else if (day < 1 || day > 31) bad(`${at}.due_day`, 'day')
        else obligation.due_day = day
      }
      return obligation
    },
  )

  const limits = isRecord(root.risk_limits) ? root.risk_limits : {}
  const riskLimits: ProfileRiskLimits = {}
  if (limits.emergency_months !== undefined) {
    riskLimits.emergency_months = whole(
      limits.emergency_months,
      'risk_limits.emergency_months',
      0,
      PROFILE_LIMITS.emergencyMonths,
    )
  }
  if (limits.max_share_in_usd !== undefined) {
    riskLimits.max_share_in_usd = whole(
      limits.max_share_in_usd,
      'risk_limits.max_share_in_usd',
      0,
      100,
    )
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    profile: {
      ...(monthlyIncome === undefined ? {} : { monthly_income: monthlyIncome }),
      currency: profileCurrency,
      goals,
      obligations,
      risk_limits: riskLimits,
    },
  }
}
