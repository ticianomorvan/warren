import PostalMime, { decodeWords } from 'postal-mime'
import type { TxtResolver } from './resolver'
import type { SenderPolicy } from './senders'
import { verifySignedMail } from './verify'

/**
 * Google's confirmation mail, sent when someone adds a Warren address as a forwarding address in
 * Gmail. A separate policy, never part of `SENDERS`: it is not a bank, and nothing it says may
 * reach the ledger path. The same DKIM verifier applies, so the signature must pass, align with
 * `google.com`, cover the whole body (no `l=`), and sign From, To, Date and Subject (Date is
 * required by the verifier, whatever this list says).
 */
export const GOOGLE_FORWARDING_POLICY: SenderPolicy = {
  id: 'google-forwarding',
  fromAddresses: ['forwarding-noreply@google.com'],
  allowedSigners: ['google.com'],
  requiredSignedHeaders: ['from', 'to', 'subject'],
  minKeyBits: 1024,
}

/**
 * How long a captured confirmation counts toward a claim, and how far back a claim looks for
 * mail to check again. The SQL function `claim_mailbox` (db migration 0013) holds its own
 * literal `interval '7 days'`: change both together.
 */
export const CONFIRMATION_WINDOW_DAYS = 7

/** Google sends the confirm link on either host (seen in real confirmations, 2026-11-19). */
const CONFIRM_HOSTS = ['mail-settings.google.com', 'mail.google.com']
const CONFIRM_PATH = '/mail/vf-'
/** Where an address ends: ASCII `local@domain` only, so punctuation around one never joins it. */
const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi

/** True for exactly Google's confirm link: https, no userinfo, one of Google's two hosts, a `vf-` path. */
export function isConfirmUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      CONFIRM_HOSTS.includes(url.hostname) &&
      url.pathname.startsWith(CONFIRM_PATH)
    )
  } catch {
    return false
  }
}

/** What the person must be shown: the Gmail asking to forward, and Google's confirm link. */
export type ForwardingConfirmation = { address: string; url: string }

/** True when an unsigned From header names Google's sender: only worth a signature check. */
export const looksLikeGoogleForwarding = (fromAddresses: readonly string[]): boolean =>
  fromAddresses.some((a) => GOOGLE_FORWARDING_POLICY.fromAddresses.includes(a))

/**
 * Pulls the two facts out of a verified confirmation, with no language-specific wording: the
 * requesting address is the one address in the signed Subject that is not the Warren address,
 * and the link is the `vf-` URL on one of Google's confirm hosts in the text body. Null when either
 * is missing or ambiguous. Pure: the caller has already verified the mail.
 */
export async function extractForwardingConfirmation(
  raw: Uint8Array,
  signedSubject: string,
  warrenAddress: string,
): Promise<ForwardingConfirmation | null> {
  const own = warrenAddress.toLowerCase()
  const found = decodeWords(signedSubject).match(ADDRESS) ?? []
  const others = new Set(found.map((a) => a.toLowerCase()).filter((a) => a !== own))
  const [address] = [...others]
  if (others.size !== 1 || !address) return null

  const { text } = await PostalMime.parse(raw)
  const url = (text?.match(/https:\/\/[^\s<>"']+/g) ?? [])
    .map((candidate) => candidate.replace(/[.,;)]+$/, ''))
    .find(isConfirmUrl)
  return url ? { address, url: new URL(url).toString() } : null
}

export type ForwardingVerdict =
  | { status: 'confirmation'; confirmation: ForwardingConfirmation }
  | { status: 'not-confirmation' }
  /** DNS trouble: could not decide. Never a rejection. */
  | { status: 'retry' }

/**
 * Decides whether raw mail is Google's genuine forwarding confirmation addressed (signed To) to
 * this Warren address, and extracts it. Anything else is `not-confirmation` and takes the
 * ordinary path. Never logs or returns the mail.
 */
export async function recognizeForwardingConfirmation(
  raw: Uint8Array,
  opts: {
    warrenAddress: string
    resolver: TxtResolver
    receivedAt: Date
    maxDateSkewMinutes: number | null
  },
): Promise<ForwardingVerdict> {
  const verdict = await verifySignedMail(raw, {
    senders: [GOOGLE_FORWARDING_POLICY],
    mailboxes: [opts.warrenAddress],
    resolver: opts.resolver,
    receivedAt: opts.receivedAt,
    maxDateSkewMinutes: opts.maxDateSkewMinutes,
  })
  if (verdict.verdict === 'retry') return { status: 'retry' }
  if (verdict.verdict !== 'verified') return { status: 'not-confirmation' }
  const confirmation = await extractForwardingConfirmation(raw, verdict.subject, opts.warrenAddress)
  return confirmation ? { status: 'confirmation', confirmation } : { status: 'not-confirmation' }
}
