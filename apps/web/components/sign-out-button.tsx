'use client'

import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { unsubscribePush } from '@/app/notifications/actions'
import { authClient } from '@/lib/auth-client'
import { t } from '@/lib/strings'

/**
 * On a shared device the next person to sign in must not get the last one's notices: remove
 * this browser's subscription, on the server (while the session still exists) and in the
 * browser. Best effort and bounded: it never keeps anyone from signing out.
 */
async function dropSubscription() {
  const work = (async () => {
    if (!('serviceWorker' in navigator)) return
    const registration = await navigator.serviceWorker.getRegistration('/sw.js')
    const subscription = await registration?.pushManager.getSubscription()
    if (!subscription) return
    await unsubscribePush(subscription.endpoint)
    await subscription.unsubscribe()
  })()
  await Promise.race([work.catch(() => {}), new Promise((done) => setTimeout(done, 3000))])
}

export function SignOutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const errorId = useId()

  async function signOut() {
    setPending(true)
    setFailed(false)
    await dropSubscription()
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
