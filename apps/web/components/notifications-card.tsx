'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { subscribePush, testPush, unsubscribePush } from '@/app/notifications/actions'
import { t } from '@/lib/strings'

type Status = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on'
type Busy = 'enable' | 'test' | 'disable' | null

/** The browser wants the VAPID key as bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/**
 * Turns notifications on and off for this browser. Subscribing needs a tap (the browser only
 * asks for permission after one), so "off" shows a button and nothing happens on its own. When
 * this browser is already subscribed, its subscription is sent again quietly: the server may
 * have dropped it, and sending an existing one changes nothing.
 */
export function NotificationsCard({ publicKey }: { publicKey: string | null }) {
  const [status, setStatus] = useState<Status>('checking')
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null)
  const messageId = useId()

  const refresh = useCallback(async () => {
    if (!supported()) return setStatus('unsupported')
    if (Notification.permission === 'denied') return setStatus('blocked')
    try {
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription && Notification.permission === 'granted') {
        setStatus('on')
        void subscribePush(subscription.toJSON())
      } else {
        setStatus('off')
      }
    } catch {
      setStatus('off')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function enable() {
    if (!publicKey) return
    setBusy('enable')
    setMessage(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'denied') return setStatus('blocked')
      if (permission !== 'granted') return setStatus('off')
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }))
      const result = await subscribePush(subscription.toJSON())
      if (!result.ok) {
        // Not stored on the server: do not leave the browser thinking it is subscribed.
        await subscription.unsubscribe()
        throw new Error('not stored')
      }
      setStatus('on')
    } catch {
      setMessage({ text: t.notifications.enableFailed, failed: true })
    } finally {
      setBusy(null)
    }
  }

  async function disable() {
    setBusy('disable')
    setMessage(null)
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js')
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const result = await unsubscribePush(subscription.endpoint)
        if (!result.ok) throw new Error('not removed')
        await subscription.unsubscribe()
      }
      setStatus('off')
    } catch {
      setMessage({ text: t.notifications.disableFailed, failed: true })
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setBusy('test')
    setMessage(null)
    try {
      const result = await testPush()
      if (result.ok) setMessage({ text: t.notifications.testSent, failed: false })
      else {
        const text =
          result.reason === 'gone' ? t.notifications.testGone : t.notifications.testFailed
        setMessage({ text, failed: true })
      }
    } catch {
      setMessage({ text: t.notifications.testFailed, failed: true })
    } finally {
      setBusy(null)
    }
  }

  const copy = !publicKey
    ? t.notifications.unconfigured
    : status === 'checking'
      ? t.notifications.checking
      : t.notifications[status]

  return (
    <section aria-labelledby="notifications" data-testid="notifications" data-status={status}>
      <h2 id="notifications">{t.notifications.title}</h2>
      <p className="note">{copy}</p>
      {publicKey && status === 'off' && (
        <div className="actions">
          <button type="button" onClick={enable} disabled={busy !== null}>
            {busy === 'enable' ? t.notifications.enabling : t.notifications.enable}
          </button>
        </div>
      )}
      {publicKey && status === 'on' && (
        <div className="actions">
          <button type="button" onClick={test} disabled={busy !== null}>
            {busy === 'test' ? t.notifications.testing : t.notifications.test}
          </button>
          <button type="button" className="quiet" onClick={disable} disabled={busy !== null}>
            {busy === 'disable' ? t.notifications.disabling : t.notifications.disable}
          </button>
        </div>
      )}
      <p
        id={messageId}
        className={message?.failed ? 'error' : 'status'}
        role={message?.failed ? 'alert' : 'status'}
      >
        {message?.text ?? null}
      </p>
    </section>
  )
}
