import { errorTag } from '@warren/core'
import { asUser, movementCount } from '@warren/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { NotificationsCard } from '@/components/notifications-card'
import { SignOutButton } from '@/components/sign-out-button'
import { database } from '@/lib/db'
import { env } from '@/lib/env'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'

/** The browser's VAPID key; null when push is not set up, or its settings are wrong (logged). */
function vapidPublicKey(): { key: string | null; broken: boolean } {
  try {
    return { key: env.vapid()?.publicKey ?? null, broken: false }
  } catch (error) {
    console.error('vapid settings:', errorTag(error))
    return { key: null, broken: true }
  }
}

export default async function Home() {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')

  // Through asUser, so row-level security shows only this user's movements. An erased user has
  // no session (erasure deletes them, and none can be made), so this never meets one.
  const vapid = vapidPublicKey()
  const count = await asUser(database(), session.user.id, movementCount)

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
          {count === 0 ? (
            <p className="note">{t.home.empty}</p>
          ) : (
            <p className="note">
              <Link href="/movements">{t.home.seeAll}</Link>
            </p>
          )}
        </section>
        <section aria-labelledby="profile">
          <h2 id="profile">{t.home.profile}</h2>
          <p className="note">{t.home.profileHint}</p>
          <p className="note">
            <Link href="/profile">{t.home.profileLink}</Link>
          </p>
        </section>
        <NotificationsCard publicKey={vapid.key} broken={vapid.broken} />
        <SignOutButton />
      </div>
    </main>
  )
}
