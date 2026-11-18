import { sha256Hex } from '../hash'
import type { Ledger, RecordOutcome } from '../ledger'
import { type ParseResult, parseBankMail, TEMPLATE_SET_VERSION, type VerifiedMail } from './parse'
import {
  fetchReceivedMail,
  parseReceivedEvent,
  verifyResendWebhook,
  type WebhookHeaders,
} from './resend'
import type { TxtResolver } from './resolver'
import { SENDER_POLICY_VERSION, type SenderPolicy } from './senders'
import { type MailVerdict, verifyBankMail } from './verify'

/** Where raw files live (Vercel Blob in production). Same pathname always means same bytes. */
export interface RawStore {
  put(pathname: string, bytes: Uint8Array, mime: string): Promise<void>
  get(pathname: string): Promise<Uint8Array | null>
}

export type NewMail = {
  sha256: string
  pathname: string
  bytes: number
  provider: string
  providerId: string
  receivedAt: Date
}

/** A mail's settled verdict: what parsing needs when verified, nothing more when rejected. */
export type FinalVerdict = { verdict: 'rejected' } | ({ verdict: 'verified' } & VerifiedMail)

export type PendingParse = VerifiedMail & { sha256: string; pathname: string }

/** Append-only record of mail, verification attempts and parses. Every write is idempotent. */
export interface MailLog {
  /** sha256 of the mail a provider delivery was recorded under, if any. */
  findDelivery(provider: string, providerId: string): Promise<string | null>
  recordMail(mail: NewMail): Promise<void>
  /** The 'verified' or 'rejected' verdict, once the mail has one. */
  finalVerdict(sha256: string): Promise<FinalVerdict | null>
  recordVerdict(sha256: string, verdict: MailVerdict, policyVersion: number): Promise<void>
  hasParse(sha256: string, templateSetVersion: number): Promise<boolean>
  /** One parse per mail and template set; a second call for the same pair is a no-op. */
  recordParse(sha256: string, templateSetVersion: number, result: ParseResult): Promise<void>
  /** Verified mails with no parse under this template set. */
  pendingParses(templateSetVersion: number): Promise<PendingParse[]>
}

export type IntakeDeps = {
  store: RawStore
  log: MailLog
  ledger: Ledger
  resolver: TxtResolver
  senders: readonly SenderPolicy[]
  ownerAddresses: readonly string[]
  maxDateSkewMinutes: number | null
}

export type IntakeResult = {
  sha256: string
  /** 'duplicate' when this exact mail was already fully processed. */
  outcome: MailVerdict['verdict'] | 'duplicate'
  reason?: string
  /** For verified mail: whether a template turned it into an operation. */
  parse?: ParseResult['status']
  parseReason?: string
  /** For parsed mail: what happened in the ledger. */
  movement?: RecordOutcome['outcome']
}

export const rawMailPathname = (sha256: string) => `raw/mail/${sha256}.eml`

/**
 * Stores the bytes first, then records, then verifies. A crash at any point is repaired by
 * running the same call again: each step is a no-op when already done.
 */
export async function intakeRawMail(
  deps: IntakeDeps,
  input: { raw: Uint8Array; provider: string; providerId: string; receivedAt: Date },
): Promise<IntakeResult> {
  const sha256 = sha256Hex(input.raw)
  const pathname = rawMailPathname(sha256)
  await deps.store.put(pathname, input.raw, 'message/rfc822')
  await deps.log.recordMail({
    sha256,
    pathname,
    bytes: input.raw.byteLength,
    provider: input.provider,
    providerId: input.providerId,
    receivedAt: input.receivedAt,
  })

  let final = await deps.log.finalVerdict(sha256)
  if (
    final &&
    (final.verdict === 'rejected' || (await deps.log.hasParse(sha256, TEMPLATE_SET_VERSION)))
  ) {
    return { sha256, outcome: 'duplicate' }
  }
  if (!final) {
    const verdict = await verifyBankMail(input.raw, {
      senders: deps.senders,
      ownerAddresses: deps.ownerAddresses,
      resolver: deps.resolver,
      receivedAt: input.receivedAt,
      maxDateSkewMinutes: deps.maxDateSkewMinutes,
    })
    await deps.log.recordVerdict(sha256, verdict, SENDER_POLICY_VERSION)
    if (verdict.verdict !== 'verified')
      return { sha256, outcome: verdict.verdict, reason: verdict.reason }
    final = verdict
  }

  const parsed = await parseBankMail(input.raw, final)
  await deps.log.recordParse(sha256, TEMPLATE_SET_VERSION, parsed)
  if (parsed.status === 'unparsed') {
    return { sha256, outcome: 'verified', parse: 'unparsed', parseReason: parsed.reason }
  }
  const recorded = await deps.ledger.recordMailOperation({
    mailSha256: sha256,
    templateId: parsed.templateId,
    operation: parsed.operation,
  })
  return { sha256, outcome: 'verified', parse: 'parsed', movement: recorded.outcome }
}

/**
 * Parses verified mail that has no parse under the current template set: mail that arrived
 * before a template existed, or before a template was fixed. Safe to run at any time.
 */
export async function parsePending(
  deps: Pick<IntakeDeps, 'store' | 'log'>,
): Promise<{ sha256: string; status: ParseResult['status'] | 'missing-file'; reason?: string }[]> {
  const out = []
  for (const mail of await deps.log.pendingParses(TEMPLATE_SET_VERSION)) {
    const raw = await deps.store.get(mail.pathname)
    if (!raw || sha256Hex(raw) !== mail.sha256) {
      out.push({ sha256: mail.sha256, status: 'missing-file' as const })
      continue
    }
    const parsed = await parseBankMail(raw, mail)
    await deps.log.recordParse(mail.sha256, TEMPLATE_SET_VERSION, parsed)
    out.push({
      sha256: mail.sha256,
      status: parsed.status,
      ...(parsed.status === 'unparsed' ? { reason: parsed.reason } : {}),
    })
  }
  return out
}

export type ResendWebhookDeps = IntakeDeps & {
  webhookSecret: string
  apiKey: string
  fetchFn?: typeof fetch
  now?: () => Date
}

export type WebhookResponse = { status: number; body: Record<string, unknown> }

/**
 * Handles one Resend webhook call. Any non-2xx answer makes Resend retry (8 attempts over
 * about 28 hours), which is the wanted behaviour for outages and for DNS trouble.
 */
export async function handleResendWebhook(
  deps: ResendWebhookDeps,
  body: string,
  headers: WebhookHeaders,
): Promise<WebhookResponse> {
  if (!verifyResendWebhook(body, headers, deps.webhookSecret, deps.now?.())) {
    return { status: 401, body: { error: 'bad signature' } }
  }
  const event = parseReceivedEvent(body)
  if (!event) return { status: 200, body: { ignored: true } }

  const known = await deps.log.findDelivery('resend', event.emailId)
  if (known) {
    const final = await deps.log.finalVerdict(known)
    const settled =
      final?.verdict === 'rejected' ||
      (final?.verdict === 'verified' && (await deps.log.hasParse(known, TEMPLATE_SET_VERSION)))
    if (settled) return { status: 200, body: { sha256: known, outcome: 'duplicate' } }
  }

  const mail = await fetchReceivedMail(event.emailId, deps.apiKey, deps.fetchFn)
  const result = await intakeRawMail(deps, {
    raw: mail.raw,
    provider: 'resend',
    providerId: event.emailId,
    receivedAt: mail.receivedAt,
  })
  return { status: result.outcome === 'retry' ? 503 : 200, body: result }
}
