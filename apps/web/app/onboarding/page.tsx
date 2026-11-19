import { inboundAddressOf } from '@warren/core'
import { asUser, inboundAddressFor, latestConfirmation, mailboxesOf } from '@warren/db'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { OnboardingPanel } from '@/components/onboarding-panel'
import { database } from '@/lib/db'
import { env } from '@/lib/env'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: `${t.onboarding.title} · ${t.appName}` }

export default async function OnboardingPage() {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')
  const { token, confirmation, mailboxes } = await asUser(
    database(),
    session.user.id,
    async (scope) => ({
      token: await inboundAddressFor(scope),
      confirmation: await latestConfirmation(scope),
      mailboxes: await mailboxesOf(scope),
    }),
  )
  // A confirmation whose address is already connected has nothing left to ask.
  const pending = confirmation && !mailboxes.includes(confirmation.address) ? confirmation : null

  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.onboarding.back}
        </Link>
        <h1>{t.onboarding.title}</h1>
        <p className="note lead">{t.onboarding.lead}</p>
        <OnboardingPanel
          address={inboundAddressOf(token, env.inboundDomain())}
          pending={pending ? { address: pending.address, url: pending.url } : null}
          mailboxes={mailboxes}
        />
      </div>
    </main>
  )
}
