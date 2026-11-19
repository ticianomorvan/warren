'use client'

import Link from 'next/link'
import { t } from '@/lib/strings'

export default function OnboardingError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.onboarding.back}
        </Link>
        <h1>{t.onboarding.title}</h1>
        <p className="error" role="alert">
          {t.onboarding.loadError}
        </p>
        <button type="button" className="quiet" onClick={reset}>
          {t.onboarding.retry}
        </button>
      </div>
    </main>
  )
}
