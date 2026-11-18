'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useId, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { t } from '@/lib/strings'

// Mirrors PASSWORD_MIN_LENGTH in @warren/core; the server is what enforces it.
const MIN_PASSWORD = 10

type Mode = 'sign-in' | 'sign-up'

function messageFor(error: {
  code?: string | undefined
  message?: string | undefined
  status?: number | undefined
}): string {
  if (error.status === 403 || error.message === 'signup_closed') return t.errors.signupClosed
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return t.errors.invalidCredentials
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return t.errors.exists
    case 'PASSWORD_TOO_SHORT':
      return t.errors.passwordLength(MIN_PASSWORD)
    default:
      return t.errors.generic
  }
}

export function AuthForm({ mode }: { mode: Mode }) {
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
      const { error: failed } =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              name: String(form.get('name') ?? '').trim(),
              email,
              password,
            })
      if (failed) {
        setError(messageFor(failed))
        setPending(false)
        return
      }
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
              minLength={mode === 'sign-up' ? MIN_PASSWORD : undefined}
              required
              aria-describedby={mode === 'sign-up' ? hintId : undefined}
            />
            {mode === 'sign-up' && <small id={hintId}>{t.fields.passwordHint(MIN_PASSWORD)}</small>}
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
