'use client'

import { useRouter } from 'next/navigation'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { claimGmail, onboardingStatus } from '@/app/onboarding/actions'
import type { FirstMail } from '@/lib/onboarding'
import { type StepState, stepStates } from '@/lib/steps'
import { t } from '@/lib/strings'

const CONNECTOR_URL = 'https://heywarren.app/api/mcp'
const CLAUDE_CODE_COMMAND = `claude mcp add --transport http warren ${CONNECTOR_URL}`
// "/u/0/" is the first signed-in account; with several, the connected Gmail's own address names the right one.
const gmailFilters = (account: string | undefined) =>
  `https://mail.google.com/mail/u/${account ? encodeURIComponent(account) : '0'}/#settings/filters`
const POLL_MS = 5000

type Message = { text: string; failed: boolean } | null

// The "opened Google's link" mark, per address, lives in this tab's session so a reload keeps it.
const openedKey = (address: string) => `warren.opened.${address}`
function wasOpened(address: string): boolean {
  try {
    return sessionStorage.getItem(openedKey(address)) === '1'
  } catch {
    return false
  }
}
function markOpened(address: string) {
  try {
    sessionStorage.setItem(openedKey(address), '1')
  } catch {
    // Without storage the mark lasts until the page reloads.
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState<Message>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setMessage({ text: t.onboarding.copied, failed: false })
    } catch {
      setMessage({ text: t.onboarding.copyFailed, failed: true })
    }
  }
  return (
    <>
      <div className="actions">
        <button type="button" className="quiet" onClick={copy} aria-label={label}>
          {t.onboarding.copy}
        </button>
      </div>
      <p
        className={message?.failed ? 'error' : 'status'}
        role={message?.failed ? 'alert' : 'status'}
      >
        {message?.text ?? null}
      </p>
    </>
  )
}

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number
  /** 'neutral' while the browser has not yet said whether Google's link was opened. */
  state: StepState | 'neutral'
  title: string
  children?: ReactNode
}) {
  const quiet = state === 'todo' || state === 'neutral'
  return (
    <li className={`step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <span className="step-mark" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className="step-body">
        <h2>
          {title}
          {state === 'neutral' ? null : (
            <span className="step-state">
              <span className="visually-hidden">{t.onboarding.stepLabel(n)}: </span>
              {t.onboarding.stepState[state]}
            </span>
          )}
        </h2>
        {/* Always mounted, so a live region inside is already there when it fills. */}
        <div hidden={quiet}>{children}</div>
      </div>
    </li>
  )
}

/**
 * The numbered sequence. The server decides which steps are done (`states`); the browser only
 * knows whether Google's link was opened, which moves step 2 to step 3 for a pending Gmail. While
 * the page is visible and the first mail has not arrived, it asks the server for the status every
 * 5 seconds and reloads itself when a request or a mailbox appeared. Address and links come from
 * the server page and go nowhere else.
 */
export function OnboardingPanel({
  address,
  pending,
  mailboxes,
  hasConfirmation,
  firstMail,
  search,
}: {
  address: string
  pending: { address: string; url: string }[]
  mailboxes: string[]
  hasConfirmation: boolean
  firstMail: FirstMail
  /** The Gmail search for the manual filter, built on the server from the sender policy. */
  search: string
}) {
  const router = useRouter()
  const [opened, setOpened] = useState<string[]>([])
  const [mounted, setMounted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [mail, setMail] = useState(firstMail)
  const hasMailbox = mailboxes.length > 0
  const pendingCount = pending.length
  const verified = mail.state === 'verified'

  useEffect(() => {
    setOpened(pending.map((p) => p.address).filter(wasOpened))
    setMounted(true)
  }, [pending])
  useEffect(() => setMail(firstMail), [firstMail])

  const poll = useCallback(async () => {
    const result = await onboardingStatus().catch(() => null)
    if (!result?.ok) return
    setMail(result.mail)
    if (
      result.pending !== pendingCount ||
      result.hasMailbox !== hasMailbox ||
      (result.mail.state === 'verified') !== verified
    )
      router.refresh()
  }, [pendingCount, hasMailbox, verified, router])

  useEffect(() => {
    if (verified) return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const sync = () => {
      stop()
      if (document.visibilityState === 'visible') {
        void poll()
        timer = setInterval(poll, POLL_MS)
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [verified, poll])

  function openGoogle(p: { address: string; url: string }) {
    window.open(p.url, '_blank', 'noopener,noreferrer')
    markOpened(p.address)
    setOpened((now) => (now.includes(p.address) ? now : [...now, p.address]))
  }

  async function claim(gmail: string) {
    setBusy(gmail)
    setMessage(null)
    try {
      const result = await claimGmail(gmail)
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

  const anyOpened = pending.some((p) => opened.includes(p.address))
  const shown = stepStates({ hasConfirmation, hasMailbox, verified, opened: anyOpened })
  // Until the browser has read which links were opened, steps 2 and 3 cannot say which is current.
  const unsure = !mounted && !hasMailbox && pending.length > 0
  const s = t.onboarding.steps

  return (
    <ol className="steps">
      <Step n={1} state={shown[0] ?? 'todo'} title={s.address}>
        {shown[0] === 'done' ? (
          <p>
            {t.onboarding.yourAddress}{' '}
            <code className="addr" data-testid="warren-address">
              {address}
            </code>
          </p>
        ) : (
          <>
            <p className="note">{t.onboarding.addressHint}</p>
            <p>
              <code className="addr" data-testid="warren-address">
                {address}
              </code>
            </p>
          </>
        )}
        <CopyButton value={address} label={`${t.onboarding.copy}: ${address}`} />
      </Step>

      <Step n={2} state={unsure ? 'neutral' : (shown[1] ?? 'todo')} title={s.confirm}>
        {hasMailbox ? (
          <ul className="plain" data-testid="mailboxes">
            {mailboxes.map((m) => (
              <li key={m}>{t.onboarding.connected(m)}</li>
            ))}
          </ul>
        ) : null}
        {pending.length > 0 ? (
          <>
            <p className="note">
              {hasMailbox ? t.onboarding.pendingMore : t.onboarding.confirmHint}
            </p>
            <ul className="plain" data-testid="pending">
              {pending.map((p) => (
                <li key={p.address}>
                  <p className="who">{p.address}</p>
                  <div className="actions">
                    <button type="button" onClick={() => openGoogle(p)}>
                      {t.onboarding.confirmInGoogle}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : hasMailbox ? null : (
          <p className="note" data-testid="pending">
            {t.onboarding.waitingGoogle}
          </p>
        )}
      </Step>

      <Step n={3} state={unsure ? 'neutral' : (shown[2] ?? 'todo')} title={s.mine}>
        {pending.length > 0 ? (
          <>
            <p className="note">{t.onboarding.mineWarning}</p>
            <ul className="plain">
              {pending.map((p) => (
                <li key={p.address}>
                  {opened.includes(p.address) ? (
                    <div className="actions">
                      <button
                        type="button"
                        onClick={() => claim(p.address)}
                        disabled={busy !== null}
                      >
                        {busy === p.address
                          ? t.onboarding.claiming
                          : t.onboarding.itsMine(p.address)}
                      </button>
                    </div>
                  ) : (
                    <p className="note">
                      <strong className="addr">{p.address}</strong>: {t.onboarding.openFirst}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p
          className={message?.failed ? 'error' : 'status'}
          role={message?.failed ? 'alert' : 'status'}
          data-testid="claim-result"
        >
          {message?.text ?? null}
        </p>
      </Step>

      <Step n={4} state={shown[3] ?? 'todo'} title={s.filter}>
        <p className="note">{t.onboarding.filterLead}</p>
        <div className="actions">
          <a className="button-link" href="/onboarding/filter.xml" download="warren-filtro.xml">
            {t.onboarding.filterDownload}
          </a>
          <a
            className="button-link quiet"
            href={gmailFilters(mailboxes[0])}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.onboarding.filterSettings}
          </a>
        </div>
        <ol className="how">
          {t.onboarding.filterSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="note">{t.onboarding.filterManual}</p>
        <p>
          <code className="addr">{search}</code>
        </p>
        <CopyButton value={search} label={`${t.onboarding.copy}: ${search}`} />
        <p className="note">
          {t.onboarding.filterManualBefore}
          <code className="addr">{address}</code>
          {t.onboarding.filterManualAfter}
        </p>
        <p className="note">{t.onboarding.filterOld}</p>
      </Step>

      <Step n={5} state={shown[4] ?? 'todo'} title={s.first}>
        <div aria-live="polite" data-testid="first-mail">
          {mail.state === 'verified' ? (
            <>
              <p>
                <strong>{t.onboarding.verifiedTitle}</strong>
              </p>
              <p className="note">{t.onboarding.verified(mail.kind, mail.date)}</p>
            </>
          ) : mail.state === 'rejected' ? (
            <>
              <p className="error">{t.onboarding.rejectedTitle}</p>
              <p className="note">{mail.reason}</p>
            </>
          ) : (
            <>
              <p className="note">{t.onboarding.waiting}</p>
              <p className="note">{t.onboarding.waitingHint}</p>
            </>
          )}
        </div>
      </Step>

      <Step n={6} state={shown[5] ?? 'todo'} title={s.agent}>
        <p className="note">{t.onboarding.agentLead}</p>
        <p>
          <code className="addr">{CONNECTOR_URL}</code>
        </p>
        <CopyButton value={CONNECTOR_URL} label={`${t.onboarding.copy}: ${CONNECTOR_URL}`} />
        <p className="note">{t.onboarding.claudeAi}</p>
        <p className="note">{t.onboarding.claudeCode}</p>
        <p>
          <code className="addr">{CLAUDE_CODE_COMMAND}</code>
        </p>
        <CopyButton value={CLAUDE_CODE_COMMAND} label={`${t.onboarding.copy}: Claude Code`} />
      </Step>
    </ol>
  )
}
