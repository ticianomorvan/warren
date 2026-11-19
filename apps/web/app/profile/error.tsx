'use client'

import Link from 'next/link'
import { t } from '@/lib/strings'

export default function ProfileError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.profile.back}
        </Link>
        <h1>{t.profile.title}</h1>
        <p className="error" role="alert">
          {t.profile.loadError}
        </p>
        <button type="button" className="quiet" onClick={reset}>
          {t.profile.retry}
        </button>
      </div>
    </main>
  )
}
