'use client'

import Link from 'next/link'
import { t } from '@/lib/strings'

/** The page failed (the database was out of reach, say). Nothing about the failure is shown. */
export default function MovementsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.movements.back}
        </Link>
        <h1>{t.movements.title}</h1>
        <p className="error" role="alert">
          {t.movements.error}
        </p>
        <button type="button" onClick={reset}>
          {t.movements.retry}
        </button>
      </div>
    </main>
  )
}
