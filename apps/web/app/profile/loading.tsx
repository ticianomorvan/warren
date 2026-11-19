import { t } from '@/lib/strings'

export default function Loading() {
  return (
    <main className="screen">
      <div className="card wide" aria-busy="true">
        <p className="back">← {t.profile.back}</p>
        <h1>{t.profile.title}</h1>
        <p className="visually-hidden" role="status">
          {t.profile.loading}
        </p>
        <div className="skeleton" aria-hidden="true">
          {[0, 1, 2].map((n) => (
            <span key={n} className="bar block" />
          ))}
        </div>
      </div>
    </main>
  )
}
