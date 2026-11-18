import type { Ledger, RecordOutcome } from '../ledger'
import { unsignedToAddresses } from './headers'
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

/**
 * Where raw files live (Vercel Blob in production). Same pathname always means same bytes.
 * Every store used for mail is per user: it seals what it writes and opens what it reads.
 */
export interface RawStore {
  put(pathname: string, bytes: Uint8Array, mime: string): Promise<void>
  get(pathname: string): Promise<Uint8Array | null>
  /** Deletes every file whose pathname starts with `prefix`. Returns how many. */
  deletePrefix(prefix: string): Promise<number>
}

export type NewMail = {
  mailId: string
  pathname: string
  bytes: number
  provider: string
  providerId: string
  receivedAt: Date
}

/** A mail's settled verdict: what parsing needs when verified, nothing more when rejected. */
export type FinalVerdict = { verdict: 'rejected' } | ({ verdict: 'verified' } & VerifiedMail)

export type PendingParse = VerifiedMail & { mailId: string; pathname: string }

/** Append-only record of one user's mail, verification attempts and parses. Writes are idempotent. */
export interface MailLog {
  /** The mail a provider delivery was recorded under, if any. */
  findDelivery(provider: string, providerId: string): Promise<string | null>
  recordMail(mail: NewMail): Promise<void>
  /** The 'verified' or 'rejected' verdict, once the mail has one. */
  finalVerdict(mailId: string): Promise<FinalVerdict | null>
  recordVerdict(mailId: string, verdict: MailVerdict, policyVersion: number): Promise<void>
  hasParse(mailId: string, templateSetVersion: number): Promise<boolean>
  /** One parse per mail and template set; a second call for the same pair is a no-op. */
  recordParse(mailId: string, templateSetVersion: number, result: ParseResult): Promise<void>
  /** Verified mails with no parse under this template set. */
  pendingParses(templateSetVersion: number): Promise<PendingParse[]>
}

/** Everything intake may touch for one user, inside that user's database transaction. */
export type UserContext = {
  userId: string
  /** Seals what it writes and opens what it reads, under the user's key. */
  store: RawStore
  log: MailLog
  ledger: Ledger
  /** The user's mailbox addresses: the signed To must name one of them. */
  mailboxes: readonly string[]
  /** The mail's identity in this user's ledger (a keyed hash, not a plain one). */
  mailId(raw: Uint8Array): string
}

/**
 * How intake reaches the database. There is no way to read or write without naming a user,
 * except the two calls that exist to find the user.
 */
export interface Tenancy {
  /** The user who registered this mailbox address, if any. */
  userForMailbox(address: string): Promise<string | null>
  /** Notes a delivery nobody claimed. Holds no content, only that it arrived. */
  recordUnrouted(delivery: {
    provider: string
    providerId: string
    receivedAt: Date
  }): Promise<void>
  withUser<T>(userId: string, fn: (ctx: UserContext) => Promise<T>): Promise<T>
}

export type IntakeDeps = {
  tenancy: Tenancy
  resolver: TxtResolver
  senders: readonly SenderPolicy[]
  maxDateSkewMinutes: number | null
}

export type IntakeResult = {
  /** Absent only when no user claims the mail's address. */
  userId?: string
  mailId?: string
  /** 'duplicate' when this exact mail was already fully processed, 'unrouted' when no user claims it. */
  outcome: MailVerdict['verdict'] | 'duplicate' | 'unrouted'
  reason?: string
  /** For verified mail: whether a template turned it into an operation. */
  parse?: ParseResult['status']
  parseReason?: string
  /** For parsed mail: what happened in the ledger. */
  movement?: RecordOutcome['outcome']
}

export const rawMailPathname = (userId: string, mailId: string) =>
  `u/${userId}/mail/${mailId}.eml.sealed`

/** Where all of one user's files live, so erasing the user can delete them by prefix. */
export const userFilesPrefix = (userId: string) => `u/${userId}/`

/**
 * Finds the user from the mail's To header, which is not signed at this point, so it only
 * chooses whose ledger checks the mail. Rule 4 still decides inside that ledger: the signed
 * To must name one of the user's mailboxes. Mail nobody claims is noted without content and
 * answered with success, so the provider does not retry it.
 */
async function route(deps: IntakeDeps, raw: Uint8Array): Promise<string | null> {
  for (const address of unsignedToAddresses(raw)) {
    const userId = await deps.tenancy.userForMailbox(address)
    if (userId) return userId
  }
  return null
}

/**
 * Stores the bytes first, then records, then verifies, all as one user. A crash at any point
 * is repaired by running the same call again: each step is a no-op when already done.
 */
export async function intakeRawMail(
  deps: IntakeDeps,
  input: { raw: Uint8Array; provider: string; providerId: string; receivedAt: Date },
): Promise<IntakeResult> {
  const userId = await route(deps, input.raw)
  if (!userId) {
    await deps.tenancy.recordUnrouted({
      provider: input.provider,
      providerId: input.providerId,
      receivedAt: input.receivedAt,
    })
    return { outcome: 'unrouted' }
  }
  return deps.tenancy.withUser(userId, (ctx) => intakeForUser(deps, ctx, input))
}

/** The same intake for a user already known, e.g. when replaying archived mail. */
export async function intakeForUser(
  deps: Pick<IntakeDeps, 'resolver' | 'senders' | 'maxDateSkewMinutes'>,
  ctx: UserContext,
  input: { raw: Uint8Array; provider: string; providerId: string; receivedAt: Date },
): Promise<IntakeResult> {
  const mailId = ctx.mailId(input.raw)
  const pathname = rawMailPathname(ctx.userId, mailId)
  const user = { userId: ctx.userId, mailId }
  await ctx.store.put(pathname, input.raw, 'message/rfc822')
  await ctx.log.recordMail({
    mailId,
    pathname,
    bytes: input.raw.byteLength,
    provider: input.provider,
    providerId: input.providerId,
    receivedAt: input.receivedAt,
  })

  let final = await ctx.log.finalVerdict(mailId)
  if (
    final &&
    (final.verdict === 'rejected' || (await ctx.log.hasParse(mailId, TEMPLATE_SET_VERSION)))
  ) {
    return { ...user, outcome: 'duplicate' }
  }
  if (!final) {
    const verdict = await verifyBankMail(input.raw, {
      senders: deps.senders,
      mailboxes: ctx.mailboxes,
      resolver: deps.resolver,
      receivedAt: input.receivedAt,
      maxDateSkewMinutes: deps.maxDateSkewMinutes,
    })
    await ctx.log.recordVerdict(mailId, verdict, SENDER_POLICY_VERSION)
    if (verdict.verdict !== 'verified') {
      return { ...user, outcome: verdict.verdict, reason: verdict.reason }
    }
    final = verdict
  }

  const parsed = await parseBankMail(input.raw, final)
  await ctx.log.recordParse(mailId, TEMPLATE_SET_VERSION, parsed)
  if (parsed.status === 'unparsed') {
    return { ...user, outcome: 'verified', parse: 'unparsed', parseReason: parsed.reason }
  }
  const recorded = await ctx.ledger.recordMailOperation({
    mailId,
    templateId: parsed.templateId,
    operation: parsed.operation,
  })
  return { ...user, outcome: 'verified', parse: 'parsed', movement: recorded.outcome }
}

/**
 * Parses verified mail that has no parse under the current template set: mail that arrived
 * before a template existed, or before a template was fixed. Safe to run at any time.
 */
export async function parsePending(
  ctx: Pick<UserContext, 'store' | 'log' | 'mailId'>,
): Promise<{ mailId: string; status: ParseResult['status'] | 'missing-file'; reason?: string }[]> {
  const out = []
  for (const mail of await ctx.log.pendingParses(TEMPLATE_SET_VERSION)) {
    const raw = await ctx.store.get(mail.pathname)
    if (!raw || ctx.mailId(raw) !== mail.mailId) {
      out.push({ mailId: mail.mailId, status: 'missing-file' as const })
      continue
    }
    const parsed = await parseBankMail(raw, mail)
    await ctx.log.recordParse(mail.mailId, TEMPLATE_SET_VERSION, parsed)
    out.push({
      mailId: mail.mailId,
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

  const mail = await fetchReceivedMail(event.emailId, deps.apiKey, deps.fetchFn)
  const result = await intakeRawMail(deps, {
    raw: mail.raw,
    provider: 'resend',
    providerId: event.emailId,
    receivedAt: mail.receivedAt,
  })
  return { status: result.outcome === 'retry' ? 503 : 200, body: result }
}
