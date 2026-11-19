'use client'

// The subpath, not the package: the package's index pulls in the server-only mail code.
import {
  PROFILE_CURRENCIES,
  PROFILE_LIMITS,
  type Profile,
  type ProfileCurrency,
  type ProfileIssue,
} from '@warren/core/profile'
import { type FormEvent, useId, useRef, useState, useTransition } from 'react'
import { saveProfile } from '@/app/profile/actions'
import { t } from '@/lib/strings'

type Goal = { key: number; name: string; target: string; currency: string; date: string }
type Obligation = { key: number; name: string; amount: string; currency: string; dueDay: string }

/** Argentines write 1500,50: the program wants 1500.50. Nothing else is touched. */
const decimal = (text: string) => text.trim().replace(',', '.')
/** Digits only become a number; anything else (1e1, 0x10, -3) goes as typed, and the server says why. */
const whole = (text: string): number | string =>
  /^\d+$/.test(text.trim()) ? Number(text.trim()) : text
/** Stored amounts have a dot; the person writes a comma, so that is what they see. */
const shown = (amount: string | undefined) => (amount ?? '').replace('.', ',')
const argentinaDate = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso))

const copy = t.profile
const message = (issue: ProfileIssue): string => {
  const m = copy.issues[issue.code]
  return typeof m === 'function' ? m(PROFILE_LIMITS.name) : m
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string | undefined
  error?: string | undefined
  children: (props: {
    id: string
    'aria-invalid': boolean
    'aria-describedby'?: string
  }) => React.ReactNode
}) {
  const id = useId()
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <small id={`${id}-error`} className="field-error">
          {error}
        </small>
      )}
    </div>
  )
}

function CurrencySelect(props: {
  id: string
  value: string
  onChange: (v: string) => void
  'aria-invalid': boolean
}) {
  return (
    <select
      id={props.id}
      value={props.value}
      aria-invalid={props['aria-invalid']}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {PROFILE_CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}

export function ProfileForm({
  initial,
  version,
  savedAt,
}: {
  initial: Profile | null
  version: number | null
  savedAt: string | null
}) {
  const next = useRef(0)
  const key = () => next.current++
  const [income, setIncome] = useState(shown(initial?.monthly_income))
  const [currency, setCurrency] = useState<string>(initial?.currency ?? 'ARS')
  const [goals, setGoals] = useState<Goal[]>(() =>
    (initial?.goals ?? []).map((g) => ({ ...g, target: shown(g.target), key: key() })),
  )
  const [obligations, setObligations] = useState<Obligation[]>(() =>
    (initial?.obligations ?? []).map((o) => ({
      key: key(),
      name: o.name,
      amount: shown(o.amount),
      currency: o.currency,
      dueDay: o.due_day === undefined ? '' : String(o.due_day),
    })),
  )
  const [emergency, setEmergency] = useState(String(initial?.risk_limits.emergency_months ?? ''))
  const [usdShare, setUsdShare] = useState(String(initial?.risk_limits.max_share_in_usd ?? ''))
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(
    version && savedAt
      ? {
          text: copy.savedBefore(version, argentinaDate(savedAt)),
          bad: false,
        }
      : null,
  )
  const [pending, startTransition] = useTransition()

  const patch = <T extends { key: number }>(
    set: (f: (rows: T[]) => T[]) => void,
    k: number,
    change: Partial<T>,
  ) => set((rows) => rows.map((r) => (r.key === k ? { ...r, ...change } : r)))

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const input = {
      ...(income.trim() === '' ? {} : { monthly_income: decimal(income) }),
      currency,
      goals: goals.map((g) => ({
        name: g.name,
        target: decimal(g.target),
        currency: g.currency,
        date: g.date,
      })),
      obligations: obligations.map((o) => ({
        name: o.name,
        amount: decimal(o.amount),
        currency: o.currency,
        ...(o.dueDay.trim() === '' ? {} : { due_day: whole(o.dueDay) }),
      })),
      risk_limits: {
        ...(emergency.trim() === '' ? {} : { emergency_months: whole(emergency) }),
        ...(usdShare.trim() === '' ? {} : { max_share_in_usd: whole(usdShare) }),
      },
    }
    startTransition(async () => {
      setStatus(null)
      let result: Awaited<ReturnType<typeof saveProfile>>
      try {
        result = await saveProfile(input)
      } catch {
        result = { ok: false, reason: 'failed' }
      }
      if (result.ok) {
        setErrors(new Map())
        setStatus({ text: copy.saved(result.version), bad: false })
      } else if (result.reason === 'invalid') {
        setErrors(new Map(result.issues.map((i) => [i.path, message(i)])))
        setStatus({ text: copy.fixErrors, bad: true })
      } else {
        setErrors(new Map())
        setStatus({
          text: result.reason === 'signed-out' ? copy.signedOut : copy.failed,
          bad: true,
        })
      }
    })
  }

  const err = (path: string) => errors.get(path)

  return (
    <form
      className="profile-form"
      onSubmit={submit}
      aria-busy={pending}
      noValidate
      data-testid="profile-form"
    >
      <section aria-labelledby="income-h" className="fields">
        <h2 id="income-h">{copy.incomeTitle}</h2>
        <div className="row-fields">
          <Field label={copy.income} hint={copy.incomeHint} error={err('monthly_income')}>
            {(p) => (
              <input
                {...p}
                inputMode="decimal"
                autoComplete="off"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
              />
            )}
          </Field>
          <Field label={copy.currency} error={err('currency')}>
            {(p) => <CurrencySelect {...p} value={currency} onChange={setCurrency} />}
          </Field>
        </div>
      </section>

      <section aria-labelledby="goals-h">
        <h2 id="goals-h">{copy.goals}</h2>
        <p className="note tight">{copy.goalsHint}</p>
        {goals.length === 0 && <p className="note">{copy.noGoals}</p>}
        <ul className="rows">
          {goals.map((g, i) => (
            <li key={g.key}>
              <fieldset>
                <legend>{copy.goalN(i + 1)}</legend>
                <Field label={copy.name} error={err(`goals.${i}.name`)}>
                  {(p) => (
                    <input
                      {...p}
                      maxLength={PROFILE_LIMITS.name}
                      autoComplete="off"
                      value={g.name}
                      onChange={(e) => patch(setGoals, g.key, { name: e.target.value })}
                    />
                  )}
                </Field>
                <div className="row-fields">
                  <Field label={copy.target} error={err(`goals.${i}.target`)}>
                    {(p) => (
                      <input
                        {...p}
                        inputMode="decimal"
                        autoComplete="off"
                        value={g.target}
                        onChange={(e) => patch(setGoals, g.key, { target: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={copy.currency} error={err(`goals.${i}.currency`)}>
                    {(p) => (
                      <CurrencySelect
                        {...p}
                        value={g.currency}
                        onChange={(v) => patch(setGoals, g.key, { currency: v })}
                      />
                    )}
                  </Field>
                </div>
                <Field label={copy.date} error={err(`goals.${i}.date`)}>
                  {(p) => (
                    <input
                      {...p}
                      type="date"
                      min="2000-01-01"
                      value={g.date}
                      onChange={(e) => patch(setGoals, g.key, { date: e.target.value })}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => {
                    setErrors(new Map())
                    setGoals((r) => r.filter((x) => x.key !== g.key))
                  }}
                >
                  {copy.remove(copy.goalN(i + 1))}
                </button>
              </fieldset>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="quiet small"
          disabled={goals.length >= PROFILE_LIMITS.goals}
          onClick={() =>
            setGoals((r) => [
              ...r,
              { key: key(), name: '', target: '', currency: currency, date: '' },
            ])
          }
        >
          {copy.addGoal}
        </button>
        {err('goals') && <p className="field-error">{err('goals')}</p>}
      </section>

      <section aria-labelledby="obl-h">
        <h2 id="obl-h">{copy.obligations}</h2>
        <p className="note tight">{copy.obligationsHint}</p>
        {obligations.length === 0 && <p className="note">{copy.noObligations}</p>}
        <ul className="rows">
          {obligations.map((o, i) => (
            <li key={o.key}>
              <fieldset>
                <legend>{copy.obligationN(i + 1)}</legend>
                <Field label={copy.name} error={err(`obligations.${i}.name`)}>
                  {(p) => (
                    <input
                      {...p}
                      maxLength={PROFILE_LIMITS.name}
                      autoComplete="off"
                      value={o.name}
                      onChange={(e) => patch(setObligations, o.key, { name: e.target.value })}
                    />
                  )}
                </Field>
                <div className="row-fields">
                  <Field label={copy.amount} error={err(`obligations.${i}.amount`)}>
                    {(p) => (
                      <input
                        {...p}
                        inputMode="decimal"
                        autoComplete="off"
                        value={o.amount}
                        onChange={(e) => patch(setObligations, o.key, { amount: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={copy.currency} error={err(`obligations.${i}.currency`)}>
                    {(p) => (
                      <CurrencySelect
                        {...p}
                        value={o.currency}
                        onChange={(v) => patch(setObligations, o.key, { currency: v })}
                      />
                    )}
                  </Field>
                </div>
                <Field
                  label={copy.dueDay}
                  hint={copy.dueDayHint}
                  error={err(`obligations.${i}.due_day`)}
                >
                  {(p) => (
                    <input
                      {...p}
                      inputMode="numeric"
                      autoComplete="off"
                      value={o.dueDay}
                      onChange={(e) => patch(setObligations, o.key, { dueDay: e.target.value })}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => {
                    setErrors(new Map())
                    setObligations((r) => r.filter((x) => x.key !== o.key))
                  }}
                >
                  {copy.remove(copy.obligationN(i + 1))}
                </button>
              </fieldset>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="quiet small"
          disabled={obligations.length >= PROFILE_LIMITS.obligations}
          onClick={() =>
            setObligations((r) => [
              ...r,
              {
                key: key(),
                name: '',
                amount: '',
                currency: currency as ProfileCurrency,
                dueDay: '',
              },
            ])
          }
        >
          {copy.addObligation}
        </button>
        {err('obligations') && <p className="field-error">{err('obligations')}</p>}
      </section>

      <section aria-labelledby="risk-h" className="fields">
        <h2 id="risk-h">{copy.risk}</h2>
        <Field
          label={copy.emergencyMonths}
          hint={copy.emergencyMonthsHint}
          error={err('risk_limits.emergency_months')}
        >
          {(p) => (
            <input
              {...p}
              inputMode="numeric"
              autoComplete="off"
              value={emergency}
              onChange={(e) => setEmergency(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={copy.maxShareInUsd}
          hint={copy.maxShareInUsdHint}
          error={err('risk_limits.max_share_in_usd')}
        >
          {(p) => (
            <input
              {...p}
              inputMode="numeric"
              autoComplete="off"
              value={usdShare}
              onChange={(e) => setUsdShare(e.target.value)}
            />
          )}
        </Field>
      </section>

      <div className="save-bar">
        <button type="submit" disabled={pending}>
          {pending ? copy.saving : copy.save}
        </button>
        <p className={status?.bad ? 'error' : 'status'} role={status?.bad ? 'alert' : 'status'}>
          {status?.text}
        </p>
      </div>
    </form>
  )
}
