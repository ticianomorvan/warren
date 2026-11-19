import { gmailFromQuery } from '@warren/core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { OnboardingPanel } from '@/components/onboarding-panel'
import { loadOnboarding, stepStates } from '@/lib/onboarding'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: `${t.onboarding.title} · ${t.appName}` }

export default async function OnboardingPage() {
  // The proxy already sent people without a session away; this is the check that counts.
  const session = await getSession()
  if (!session) redirect('/sign-in')
  const { address, pending, mailboxes, hasConfirmation, firstMail } = await loadOnboarding(
    session.user.id,
  )
  const states = stepStates({
    hasConfirmation,
    hasMailbox: mailboxes.length > 0,
    verified: firstMail.state === 'verified',
  })

  return (
    <main className="screen">
      <div className="card wide">
        <Link className="back" href="/">
          ← {t.onboarding.back}
        </Link>
        <h1>{t.onboarding.title}</h1>
        <p className="note lead">{t.onboarding.lead}</p>
        <OnboardingPanel
          address={address}
          pending={pending}
          mailboxes={mailboxes}
          states={states}
          firstMail={firstMail}
          search={gmailFromQuery()}
        />
      </div>
    </main>
  )
}
