import {
  COMBINING_MARKS,
  FOLD_FROM,
  FOLD_SPACE,
  FOLD_TO,
  monthRange,
  parseAmount,
  parseMonth,
  parseRule,
  type RuleClass,
  type RuleInput,
  type RuleScheme,
} from '@warren/core'
import { sql } from 'drizzle-orm'
import { lockUserExclusive, rowsOf, type Scope } from './client'
import { allowance, rule } from './schema'

/** The advisory-lock purpose that puts one user's rule changes in a line (4200 to 4204 are taken). */
const RULE_LOCK = 4205

/** Refused input: the message names what to fix. */
export class AllowanceInputError extends Error {}

/**
 * Appends a monthly ARS allowance that applies from `month` ("2026-11") until a later row says
 * otherwise. It is stored valid from that month's first day (the table refuses any other), so a
 * new amount set during November applies to the whole of November and to no earlier month.
 * `amount` is a positive decimal string with at most two decimals, as in the profile. Setting the
 * same month twice is allowed: the later row wins.
 */
export async function setAllowance(scope: Scope, amount: string, month: string): Promise<void> {
  const clean = parseAmount(amount)
  if (clean === null)
    throw new AllowanceInputError('amount must be a positive decimal, at most 2 decimals')
  const parsed = parseMonth(month)
  if (!parsed || parsed.year < 2000) throw new AllowanceInputError('month must look like 2026-11')
  const { from } = monthRange(parsed.year, parsed.month)
  await scope.tx.insert(allowance).values({ amount: clean, currency: 'ARS', validFrom: from })
}

export type StoredRule = {
  id: string
  scheme: RuleScheme
  value: string
  class: RuleClass
  created_at: string
}

/** Appends a rule and returns its id. The value is validated and, for a merchant, folded (core `parseRule`). */
export async function addRule(scope: Scope, input: RuleInput): Promise<string> {
  const parsed = parseRule(input)
  if (!parsed.ok) throw new AllowanceInputError(`invalid rule ${parsed.issue}`)
  const { scheme, value, class: cls } = parsed.rule
  const [row] = await scope.tx
    .insert(rule)
    .values({ matchScheme: scheme, matchValue: value, class: cls })
    .returning({ id: rule.id })
  if (!row) throw new Error('inserting a rule returned no row')
  return row.id
}

/**
 * Revokes a rule by appending a row that names it. True when it was active; false when it does
 * not exist, belongs to someone else (row-level security hides it), is itself a revocation or is
 * already revoked. Takes a per-user lock so two revokes of one rule give one row and one answer.
 */
export async function revokeRule(scope: Scope, ruleId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ruleId)) return false
  await lockUserExclusive(scope.tx, scope.userId, RULE_LOCK)
  const rows = rowsOf<{ id: string }>(
    await scope.tx.execute(sql`
      insert into rule (revokes)
      select r.id from rule r
      where r.id = ${ruleId}::uuid and r.revokes is null
        and not exists (select 1 from rule v where v.revokes = r.id)
      returning id`),
  )
  return rows.length === 1
}

/** The rules in force, newest first: those no row revokes. */
export async function activeRules(scope: Scope): Promise<StoredRule[]> {
  const rows = rowsOf<{
    id: string
    scheme: RuleScheme
    value: string
    class: RuleClass
    created_at: Date | string
  }>(
    await scope.tx.execute(sql`
      select r.id, r.match_scheme as scheme, r.match_value as value, r.class, r.created_at
      from rule r
      where r.revokes is null and not exists (select 1 from rule v where v.revokes = r.id)
      order by r.seq desc`),
  )
  return rows.map((r) => ({
    id: r.id,
    scheme: r.scheme,
    value: r.value,
    class: r.class,
    created_at: new Date(r.created_at).toISOString(),
  }))
}

export type AllowanceMonth = {
  month: string
  /** The allowance in force for the month, or null when none is. */
  amount: string | null
  /** Counted spend: class `allowance`. */
  spent: string
  /** `amount - spent`, negative when overspent; null when there is no allowance. */
  left: string | null
  /** Class `fixed`, reported apart. */
  fixed: string
  /** Class `excluded`. */
  excluded: string
  currency: 'ARS'
}

/** The fold of a column, written with the same strings the write side folds with (core). */
const folded = (column: ReturnType<typeof sql>) =>
  sql`btrim(regexp_replace(translate(regexp_replace(${column}, ${COMBINING_MARKS}, '', 'g'), ${FOLD_FROM}, ${FOLD_TO}), ${FOLD_SPACE}, ' ', 'g'), ' ')`

/** The rules in force, as a CTE named `active`. */
const ACTIVE = sql`active as (
  select r.id, r.seq, r.match_scheme, r.match_value, r.class, r.created_at
  from rule r
  where r.revokes is null and not exists (select 1 from rule v where v.revokes = r.id)
)`

/** The class of the movement `m` (a SQL alias) under the rules in `active`: the newest match, else `allowance`. */
const classOf = (m: ReturnType<typeof sql>) => sql`coalesce((
  select a.class from active a
  where (a.match_scheme = 'counterparty-account' and a.match_value = ${m}.counterparty_account)
     or (a.match_scheme = 'counterparty-tax-id' and a.match_value = ${m}.counterparty_tax_id)
     or (a.match_scheme = 'merchant' and ${m}.type = 'card_purchase'
         and a.match_value = ${folded(sql`${m}.counterparty_name`)})
  order by a.seq desc limit 1
), 'allowance')`

/** What counts toward the allowance before the rules: ARS, out, not an own transfer. For the movement alias `m`. */
const countable = (m: ReturnType<typeof sql>) =>
  sql`${m}.currency = 'ARS' and ${m}.direction = 'out' and ${m}.type <> 'own_transfer'`

/** The allowance in force on the day `first` (a SQL expression): the latest row valid on or before it. */
const allowanceOn = (first: ReturnType<typeof sql>) => sql`(
  select a.amount from allowance a where a.valid_from <= ${first}
  order by a.valid_from desc, a.seq desc limit 1
)`

/**
 * What the person meant to spend in `month` ("2026-11", an Argentine calendar month) and what is
 * left. All arithmetic is SQL on numeric (rule 1); amounts come back as decimal strings in the
 * movement's scale. Counted movements are ARS, direction out, not `own_transfer`, dated in the
 * month. Each is classified now, by the active rules that match it (read-time, so a rule applies
 * to the past and the future with nothing reprojected): `counterparty-account` against
 * `counterparty_account`, `counterparty-tax-id` against `counterparty_tax_id`, `merchant` against a
 * card purchase's folded `counterparty_name`. When several match, the newest rule wins (the highest `seq`, the insertion order); none means class `allowance`. Inbound money never adds back.
 * The allowance is the latest row (by `valid_from`, then `seq`) whose
 * `valid_from` is on or before the month's first day.
 */
export async function allowanceMonth(scope: Scope, month: string): Promise<AllowanceMonth> {
  const parsed = parseMonth(month)
  if (!parsed) throw new AllowanceInputError('month must look like 2026-11')
  const { from, to } = monthRange(parsed.year, parsed.month)
  const [row] = rowsOf<{
    amount: string | null
    spent: string
    left: string | null
    fixed: string
    excluded: string
  }>(
    await scope.tx.execute(sql`
      with ${ACTIVE},
      counted as (
        select m.amount, ${classOf(sql`m`)} as class
        from movement m
        where ${countable(sql`m`)} and m.date >= ${from}::date and m.date <= ${to}::date
      ),
      totals as (
        select coalesce(sum(amount) filter (where class = 'allowance'), 0::numeric(28,8)) as spent,
               coalesce(sum(amount) filter (where class = 'fixed'), 0::numeric(28,8)) as fixed,
               coalesce(sum(amount) filter (where class = 'excluded'), 0::numeric(28,8)) as excluded
        from counted
      ),
      current as (select ${allowanceOn(sql`${from}::date`)} as amount)
      select current.amount::text as amount,
             totals.spent::text as spent,
             (current.amount - totals.spent)::text as left,
             totals.fixed::text as fixed,
             totals.excluded::text as excluded
      from totals, current`),
  )
  if (!row) throw new Error('allowance query returned no row')
  return {
    month,
    amount: row.amount,
    spent: row.spent,
    left: row.left,
    fixed: row.fixed,
    excluded: row.excluded,
    currency: 'ARS',
  }
}

// Sealed: the allowance figure stored with a notice. A movement has one notice, so it names it.
export const figureAad = (movementId: string) => `notice:${movementId}:figure`

/** What a notice says about the allowance: the month and what was left, as the database computed them. */
export type AllowanceFigure = { month: string; left: string }

/**
 * The figure for a notice about `movementId`, which must already be inserted: what is left of
 * its month's allowance now, counting it. Null when the movement does not count (not ARS, not
 * out, an own transfer, or class `fixed` or `excluded` under the rules in force) or no allowance
 * applies to its month. The caller holds the ledger lock, so "now" is right after this movement.
 */
export async function figureFor(scope: Scope, movementId: string): Promise<AllowanceFigure | null> {
  const [row] = rowsOf<{ month: string; left: string }>(
    await scope.tx.execute(sql`
      with ${ACTIVE},
      target as (
        select date_trunc('month', m.date)::date as first
        from movement m
        where m.id = ${movementId}::uuid and ${countable(sql`m`)} and ${classOf(sql`m`)} = 'allowance'
      ),
      spent as (
        select t.first, coalesce(sum(m.amount), 0::numeric(28,8)) as total
        from target t
        join movement m on ${countable(sql`m`)}
          and m.date >= t.first and m.date < t.first + interval '1 month'
          and ${classOf(sql`m`)} = 'allowance'
        group by t.first
      )
      select to_char(spent.first, 'YYYY-MM') as month,
             (${allowanceOn(sql`spent.first`)} - spent.total)::text as left
      from spent
      where ${allowanceOn(sql`spent.first`)} is not null`),
  )
  return row ? { month: row.month, left: row.left } : null
}
