import { t } from '@/lib/strings'

/** Rows the shape of the real ones, so the page does not jump when the data arrives. */
export default function Loading() {
  return (
    <main className="screen">
      <div className="card wide" aria-busy="true">
        <p className="back">← {t.movements.back}</p>
        <h1>{t.movements.title}</h1>
        <p className="visually-hidden" role="status">
          {t.movements.loading}
        </p>
        <ul className="movements skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((n) => (
            <li key={n}>
              <div className="what">
                <span className="bar" />
                <span className="bar short" />
              </div>
              <span className="bar amount-bar" />
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
