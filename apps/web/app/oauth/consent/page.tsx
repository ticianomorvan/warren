import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ConsentActions } from '@/components/consent-actions'
import { env } from '@/lib/env'
import { getSession } from '@/lib/session'
import { t } from '@/lib/strings'

export const metadata: Metadata = { title: `${t.consent.title} · ${t.appName}` }
export const dynamic = 'force-dynamic'

const hostOf = (value: string | null): string | null => {
  try {
    return value ? new URL(value).host : null
  } catch {
    return null
  }
}

/**
 * Asks a person to let an app read their ledger. It names the app by the host of its `client_id`
 * and where it will send them back (`redirect_uri`), never by the name the app gives itself: a
 * name is anyone's to claim. Both come from the signed query, which is verified here before it is
 * shown and again by the server when the person decides.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item)
    }
  }

  // Signed out (the session ended since the app sent them here): sign in, then come back.
  if (!(await getSession())) redirect(`/sign-in?${params}`)

  // The whole query, so a parameter added after signing fails too. A person's browser may carry
  // more than the signed names only if something tampered with the link.
  const valid = await verifyOAuthQueryParams(params.toString(), env.authSecret())
  const app = valid ? hostOf(params.get('client_id')) : null
  const returnsTo = valid ? hostOf(params.get('redirect_uri')) : null
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean)

  return (
    <main className="screen">
      <div className="card">
        <p className="brand">{t.appName}</p>
        <h1>{t.consent.title}</h1>
        {app && returnsTo ? (
          <>
            <p>{t.consent.lead}</p>
            <section aria-labelledby="app">
              <h2 id="app">{t.consent.app}</h2>
              <p data-testid="consent-app">{app}</p>
            </section>
            <section aria-labelledby="returns">
              <h2 id="returns">{t.consent.returnsTo}</h2>
              <p data-testid="consent-returns-to">{returnsTo}</p>
            </section>
            <section aria-labelledby="can">
              <h2 id="can">{t.consent.canDo}</h2>
              <ul data-testid="consent-scopes">
                {scopes.map((scope) => (
                  <li key={scope}>{t.consent.scopes[scope] ?? scope}</li>
                ))}
              </ul>
            </section>
            <p className="note">{t.consent.hint}</p>
            <ConsentActions />
          </>
        ) : (
          <p className="error" role="alert">
            {t.consent.invalid}
          </p>
        )}
      </div>
    </main>
  )
}
