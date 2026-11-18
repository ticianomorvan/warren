'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { t } from '@/lib/strings'

/** Permitir or Cancelar. The server answers with where to send the person next. */
export function ConsentActions() {
  const [pending, setPending] = useState<'accept' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function decide(accept: boolean) {
    if (pending) return
    setPending(accept ? 'accept' : 'deny')
    setError(null)
    try {
      const { data, error: failed } = await authClient.oauth2.consent({ accept })
      if (failed || !data?.url) {
        // The signed query lasts 10 minutes; past that the server answers invalid_signature.
        const expired = (failed as { error?: unknown } | null)?.error === 'invalid_signature'
        setError(expired ? t.consent.invalid : t.consent.failed)
        setPending(null)
        return
      }
      // Better Auth's client has already started following `data.url` (its redirect plugin): the
      // buttons stay disabled until the page goes.
    } catch {
      setError(t.consent.failed)
      setPending(null)
    }
  }

  return (
    <div>
      <div className="actions" aria-busy={pending !== null}>
        <button type="button" disabled={pending !== null} onClick={() => decide(true)}>
          {pending === 'accept' ? t.consent.allowing : t.consent.allow}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          {pending === 'deny' ? t.consent.denying : t.consent.deny}
        </button>
      </div>
      <p className="error" role="alert">
        {error}
      </p>
    </div>
  )
}
