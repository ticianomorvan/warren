import { asUser, listMovements, type MovementListItem } from '@warren/db'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { database } from '@/lib/db'
import { dayHeading, movementAmount, movementDetail, movementTitle } from '@/lib/movements'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: `${t.movements.title} · ${t.appName}` }

/** Groups a page by day, keeping the order it came in. */
function byDay(items: MovementListItem[]) {
  const days: { date: string; items: MovementListItem[] }[] = []
  for (const item of items) {
    const last = days.at(-1)
    if (last?.date === item.date) last.items.push(item)
    else days.push({ date: item.date, items: [item] })
  }
  return days
}

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>
}) {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')
  const { cursor } = await searchParams
  const page = await asUser(database(), session.user.id, (scope) =>
    listMovements(scope, typeof cursor === 'string' ? cursor : null),
  )
  const thisYear = new Date().getFullYear()

  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.movements.back}
        </Link>
        <h1>{t.movements.title}</h1>
        {page.items.length === 0 ? (
          <div className="empty" data-testid="movements-empty">
            <p>{t.movements.empty}</p>
            <p className="note">{t.movements.emptyHint}</p>
          </div>
        ) : (
          <div data-testid="movements">
            {byDay(page.items).map((day) => (
              <section key={day.date} aria-labelledby={`day-${day.date}`}>
                <h2 id={`day-${day.date}`}>{dayHeading(day.date, thisYear)}</h2>
                <ul className="movements">
                  {day.items.map((m) => (
                    <li key={m.id}>
                      <div className="what">
                        <span className="title">{movementTitle(m)}</span>
                        <span className="detail">{movementDetail(m)}</span>
                      </div>
                      <span className={`amount ${m.direction}`}>{movementAmount(m)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {page.next && (
          <Link className="more" href={`/movements?cursor=${encodeURIComponent(page.next)}`}>
            {t.movements.more}
          </Link>
        )}
      </div>
    </main>
  )
}
