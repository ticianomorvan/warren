'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { t } from '@/lib/strings'

export function SignOutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function signOut() {
    setPending(true)
    try {
      await authClient.signOut()
    } finally {
      router.replace('/sign-in')
      router.refresh()
    }
  }

  return (
    <button type="button" className="quiet" onClick={signOut} disabled={pending}>
      {pending ? t.home.signingOut : t.home.signOut}
    </button>
  )
}
