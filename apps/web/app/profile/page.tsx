import { asUser, latestProfile } from '@warren/db'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ProfileForm } from '@/components/profile-form'
import { database } from '@/lib/db'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: `${t.profile.title} · ${t.appName}` }

export default async function ProfilePage() {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')
  const stored = await asUser(database(), session.user.id, latestProfile)

  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.profile.back}
        </Link>
        <h1>{t.profile.title}</h1>
        <p className="note lead">{t.profile.lead}</p>
        <ProfileForm
          initial={stored?.profile ?? null}
          version={stored?.version ?? null}
          savedAt={stored?.created_at ?? null}
        />
      </div>
    </main>
  )
}
