'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useId, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { type Mode, messageFor } from '@/lib/auth-errors'
import { t } from '@/lib/strings'

/** `minPassword` is the server's own rule, passed down from @warren/core so there is one. */
export function AuthForm({ mode, minPassword }: { mode: Mode; minPassword: number }) {
  const router = useRouter()
  const copy = mode === 'sign-in' ? t.signIn : t.signUp
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  const hintId = useId()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    setPending(true)
    setError(null)
    try {
      const { data, error: failed } =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              name: String(form.get('name') ?? '').trim(),
              email,
              password,
            })
      if (failed) {
        // The signed query of an agent's connection lasts 10 minutes; past that the server says so.
        const expired = (failed as { error?: unknown }).error === 'invalid_signature'
        setError(expired ? t.consent.invalid : messageFor(mode, failed, minPassword))
        setPending(false)
        return
      }
      // In the middle of an agent's connection the response says where to go next (the consent
      // page, or back to the agent) and the client follows it: do not also go home.
      if ((data as { redirect?: boolean } | null)?.redirect) return
      router.replace('/')
      router.refresh()
    } catch {
      setError(t.errors.generic)
      setPending(false)
    }
  }

  return (
    <main className="screen">
      <div className="card">
        <p className="brand">{t.appName}</p>
        <h1>{copy.title}</h1>
        <form onSubmit={submit} aria-busy={pending}>
          {mode === 'sign-up' && (
            <label className="field">
              <span>{t.fields.name}</span>
              <input name="name" type="text" autoComplete="name" required />
            </label>
          )}
          <label className="field">
            <span>{t.fields.email}</span>
            <input
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </label>
          <label className="field">
            <span>{t.fields.password}</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              minLength={mode === 'sign-up' ? minPassword : undefined}
              required
              aria-describedby={mode === 'sign-up' ? hintId : undefined}
            />
            {mode === 'sign-up' && <small id={hintId}>{t.fields.passwordHint(minPassword)}</small>}
          </label>
          <p id={errorId} className="error" role="alert">
            {error}
          </p>
          <button type="submit" disabled={pending}>
            {pending ? copy.pending : copy.submit}
          </button>
        </form>
        {mode === 'sign-up' && <p className="note">{t.signUp.hint}</p>}
        <p className="switch">
          {copy.switch}{' '}
          <Link href={mode === 'sign-in' ? '/sign-up' : '/sign-in'}>{copy.switchLink}</Link>
        </p>
      </div>
    </main>
  )
}
