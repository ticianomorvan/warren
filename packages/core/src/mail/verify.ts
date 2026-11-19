import { dkimVerify } from 'mailauth'
import { addressesIn, headerValue } from './headers'
import type { TxtResolver } from './resolver'
import type { SenderPolicy } from './senders'

/** Every reason a mail can be rejected. A const list, so a page can map each one and a test can check it did. */
export const REJECT_REASONS = [
  'from-invalid',
  'unknown-sender',
  'no-signature-from-sender',
  'signature-failed',
  'not-aligned',
  'body-length-limited',
  'header-not-signed',
  'weak-key',
  'not-addressed-to-user',
  'date-missing',
  'date-skew',
] as const

export type RejectReason = (typeof REJECT_REASONS)[number]

export type MailVerdict =
  | {
      verdict: 'verified'
      senderId: string
      fromAddress: string
      signingDomain: string
      selector: string
      /** The DNS TXT record used, kept so the mail can be re-checked after a key rotation. */
      keyRecord: string
      signedHeaders: string[]
      /** Raw value of the signed Subject header (still RFC 2047 encoded). */
      subject: string
      signedDate: Date
    }
  | {
      verdict: 'rejected'
      reason: RejectReason
      /** Whoever the mail says it is from: for an unmatched sender, anyone. Treat as personal. */
      fromAddress: string | null
      /** Set once `fromAddress` matched an allow-listed sender: only then is it the bank's. */
      senderId?: string
      detail?: string
    }
  /** Could not decide now (DNS trouble). Never treated as a rejection. */
  | { verdict: 'retry'; reason: 'dns-temperror'; fromAddress: string | null; senderId?: string }

export type VerifyOptions = {
  senders: readonly SenderPolicy[]
  /** The user's mailbox addresses. The signed To header must name one of them. */
  mailboxes: readonly string[]
  resolver: TxtResolver
  /** When the mail reached the mailbox provider. The signed Date must be close to it. */
  receivedAt: Date
  /** null disables the check, for importing old mail. */
  maxDateSkewMinutes: number | null
}

// Order of the checks below; the furthest one a candidate signature reached is reported.
const REASON_ORDER: RejectReason[] = [
  'signature-failed',
  'not-aligned',
  'body-length-limited',
  'weak-key',
  'header-not-signed',
  'not-addressed-to-user',
  'date-missing',
  'date-skew',
]

/**
 * Decides whether raw mail bytes are a genuine, unmodified mail from an allow-listed sender (a
 * bank, or Google's forwarding confirmation under its own policy), addressed to one of the
 * given mailboxes. Everything it reads comes from header lines the bank's
 * signature covers; unsigned headers (which anyone can add) are never consulted.
 */
export async function verifySignedMail(raw: Uint8Array, opts: VerifyOptions): Promise<MailVerdict> {
  const result = await dkimVerify(Buffer.from(raw), {
    resolver: opts.resolver,
    minBitLength: 1024,
    curTime: opts.receivedAt,
  })

  const fromAddress = result.headerFrom[0]?.toLowerCase() ?? null
  if (result.fromFields !== 1 || result.headerFrom.length !== 1 || fromAddress === null) {
    return { verdict: 'rejected', reason: 'from-invalid', fromAddress }
  }
  const sender = opts.senders.find((s) => s.fromAddresses.includes(fromAddress))
  if (!sender) return { verdict: 'rejected', reason: 'unknown-sender', fromAddress }

  const candidates = result.results.filter(
    (r) => r.signingDomain && sender.allowedSigners.includes(r.signingDomain.toLowerCase()),
  )
  if (candidates.length === 0) {
    return {
      verdict: 'rejected',
      reason: 'no-signature-from-sender',
      fromAddress,
      senderId: sender.id,
    }
  }

  const mailboxes = opts.mailboxes.map((a) => a.toLowerCase())
  let furthest: { reason: RejectReason; detail?: string } | null = null
  let sawTempError = false
  const fail = (reason: RejectReason, detail?: string) => {
    if (!furthest || REASON_ORDER.indexOf(reason) > REASON_ORDER.indexOf(furthest.reason)) {
      furthest = detail === undefined ? { reason } : { reason, detail }
    }
  }

  for (const sig of candidates) {
    const status = sig.status?.result
    if (status === 'temperror') {
      sawTempError = true
      continue
    }
    if (status !== 'pass') {
      fail('signature-failed', sig.info ?? undefined)
      continue
    }
    if (!sig.status?.aligned) {
      fail('not-aligned')
      continue
    }
    if (sig.canonBodyLengthLimited) {
      fail('body-length-limited')
      continue
    }
    if ((sig.modulusLength ?? 0) < sender.minKeyBits) {
      fail('weak-key', String(sig.modulusLength))
      continue
    }
    const signedHeaders = (sig.signingHeaders?.keys ?? '')
      .split(':')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
    const missing = sender.requiredSignedHeaders.filter((h) => !signedHeaders.includes(h))
    if (missing.length > 0) {
      fail('header-not-signed', missing.join(','))
      continue
    }
    const lines = sig.signingHeaders?.headers ?? []
    const to = headerValue(lines, 'to')
    if (!to || !addressesIn(to).some((a) => mailboxes.includes(a))) {
      fail('not-addressed-to-user')
      continue
    }
    const dateValue = headerValue(lines, 'date')
    const signedDate = dateValue ? new Date(dateValue) : null
    if (!signedDate || Number.isNaN(signedDate.getTime())) {
      fail('date-missing')
      continue
    }
    if (opts.maxDateSkewMinutes !== null) {
      const skewMin = Math.abs(opts.receivedAt.getTime() - signedDate.getTime()) / 60_000
      if (skewMin > opts.maxDateSkewMinutes) {
        fail('date-skew', `${Math.round(skewMin)} min`)
        continue
      }
    }
    return {
      verdict: 'verified',
      senderId: sender.id,
      fromAddress,
      signingDomain: (sig.signingDomain ?? '').toLowerCase(),
      selector: sig.selector ?? '',
      keyRecord: sig.rr ?? '',
      signedHeaders,
      subject: headerValue(lines, 'subject') ?? '',
      signedDate,
    }
  }

  if (sawTempError)
    return { verdict: 'retry', reason: 'dns-temperror', fromAddress, senderId: sender.id }
  const f = furthest as { reason: RejectReason; detail?: string } | null
  return {
    verdict: 'rejected',
    reason: f?.reason ?? 'signature-failed',
    fromAddress,
    senderId: sender.id,
    ...(f?.detail ? { detail: f.detail } : {}),
  }
}
