import { asUser, movementCount, UserErasedError } from '@warren/db'
import { redirect } from 'next/navigation'
import { SignOutButton } from '@/components/sign-out-button'
import { database } from '@/lib/db'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'

export default async function Home() {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')

  // Through asUser, so row-level security shows only this user's movements.
  const count = await asUser(database(), session.user.id, movementCount).catch((error) => {
    if (error instanceof UserErasedError) return null
    throw error
  })
  // An erased user keeps a session until they leave. Sending them to /sign-in would loop (the
  // proxy sends a signed-in person back), so say so and offer the way out.
  if (count === null) {
    return (
      <main className="screen">
        <div className="card">
          <p className="brand">{t.appName}</p>
          <h1>{t.home.erased}</h1>
          <SignOutButton />
        </div>
      </main>
    )
  }

  return (
    <main className="screen">
      <div className="card">
        <p className="brand">{t.appName}</p>
        <h1>{t.home.hello(session.user.name)}</h1>
        <section aria-labelledby="movements">
          <h2 id="movements">{t.home.title}</h2>
          <p className="count" data-testid="movement-count">
            <strong>{count}</strong>
            <span>{t.home.unit(count)}</span>
          </p>
          {count === 0 && <p className="note">{t.home.empty}</p>}
        </section>
        <SignOutButton />
      </div>
    </main>
  )
}
