'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { claimGmail } from '@/app/onboarding/actions'
import { t } from '@/lib/strings'

type Message = { text: string; failed: boolean } | null

/**
 * The address to copy, Google's pending request with its two buttons, and the connected Gmails.
 * The link opens Google's page in a new tab; "Sí, es mi Gmail" asks the server to claim, and the
 * database decides. The address and link come from the server page and go nowhere else.
 */
export function OnboardingPanel({
  address,
  pending,
  mailboxes,
}: {
  address: string
  pending: { address: string; url: string }[]
  mailboxes: string[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<Message>(null)
  const [message, setMessage] = useState<Message>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied({ text: t.onboarding.copied, failed: false })
    } catch {
      setCopied({ text: t.onboarding.copyFailed, failed: true })
    }
  }

  async function claim(address: string) {
    setBusy(address)
    setMessage(null)
    try {
      const result = await claimGmail(address)
      if (!result.ok) {
        setMessage({
          text: result.reason === 'signed-out' ? t.onboarding.signedOut : t.onboarding.failed,
          failed: true,
        })
        return
      }
      const failed = result.status === 'taken' || result.status === 'no-confirmation'
      const rescued = result.rescued > 0 ? ` ${t.onboarding.rescued(result.rescued)}` : ''
      setMessage({ text: `${t.onboarding.claim[result.status]}${rescued}`, failed })
      router.refresh()
    } catch {
      setMessage({ text: t.onboarding.failed, failed: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section aria-labelledby="address">
        <h2 id="address">{t.onboarding.addressTitle}</h2>
        <p className="note">{t.onboarding.addressHint}</p>
        <p>
          <code data-testid="warren-address" style={{ wordBreak: 'break-all' }}>
            {address}
          </code>
        </p>
        <div className="actions">
          <button type="button" className="quiet" onClick={copy}>
            {t.onboarding.copy}
          </button>
        </div>
        <p
          className={copied?.failed ? 'error' : 'status'}
          role={copied?.failed ? 'alert' : 'status'}
        >
          {copied?.text ?? null}
        </p>
      </section>

      <section aria-labelledby="pending" data-testid="pending">
        <h2 id="pending">{t.onboarding.pendingTitle}</h2>
        {pending.length > 0 ? (
          <>
            <p className="note">{t.onboarding.pendingWarning}</p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {pending.map((p) => (
                <li key={p.address} style={{ marginTop: 16 }}>
                  <p style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {p.address}
                  </p>
                  <p className="note" style={{ marginTop: 4 }}>
                    {t.onboarding.pendingHint}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => window.open(p.url, '_blank', 'noopener,noreferrer')}
                    >
                      {t.onboarding.confirmInGoogle}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => claim(p.address)}
                      disabled={busy !== null}
                    >
                      {busy === p.address ? t.onboarding.claiming : t.onboarding.itsMine(p.address)}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="note">{t.onboarding.noPending}</p>
        )}
        <p
          className={message?.failed ? 'error' : 'status'}
          role={message?.failed ? 'alert' : 'status'}
          data-testid="claim-result"
        >
          {message?.text ?? null}
        </p>
      </section>

      <section aria-labelledby="mailboxes">
        <h2 id="mailboxes">{t.onboarding.mailboxesTitle}</h2>
        {mailboxes.length === 0 ? (
          <p className="note">{t.onboarding.noMailboxes}</p>
        ) : (
          <ul data-testid="mailboxes">
            {mailboxes.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
