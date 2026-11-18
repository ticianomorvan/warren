'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { t } from '@/lib/strings'

export function SignOutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const errorId = useId()

  async function signOut() {
    setPending(true)
    setFailed(false)
    try {
      const { error } = await authClient.signOut()
      if (error) throw error
    } catch {
      // Still signed in: say so, and let them try again. Redirecting would pretend they left.
      setFailed(true)
      setPending(false)
      return
    }
    router.replace('/sign-in')
    router.refresh()
  }

  return (
    <>
      <button
        type="button"
        className="quiet"
        onClick={signOut}
        disabled={pending}
        aria-describedby={failed ? errorId : undefined}
      >
        {pending ? t.home.signingOut : t.home.signOut}
      </button>
      <p id={errorId} className="error" role="alert">
        {failed ? t.home.signOutFailed : null}
      </p>
    </>
  )
}
