import type { Ledger, RecordOutcome } from '../ledger'
import { unsignedToAddresses } from './headers'
import { type ParseResult, parseBankMail, TEMPLATE_SET_VERSION, type VerifiedMail } from './parse'
import {
  fetchReceivedMail,
  parseReceivedEvent,
  type ReceivedMail,
  verifyResendWebhook,
  type WebhookHeaders,
} from './resend'
import type { TxtResolver } from './resolver'
import { SENDER_POLICY_VERSION, type SenderPolicy } from './senders'
import { type MailVerdict, verifyBankMail } from './verify'

/**
 * Where raw files live (Vercel Blob in production). Every store used for mail is per user: it
 * seals what it writes and opens what it reads. A put under an existing pathname replaces the
 * file with a fresh seal (new nonce) of the same bytes, so intake looks in the log first and
 * puts a mail's file only once.
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
  /** Whether this mail was recorded. A recorded mail's file was stored before it was recorded. */
  hasMail(mailId: string): Promise<boolean>
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
  /**
   * Seals what it writes and opens what it reads, under the user's key. It holds the key, not
   * the connection: it keeps working after the transaction ends, so file I/O stays outside.
   */
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
  /** One short transaction as the user. Do no network or file I/O inside `fn`. */
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

export type MailInput = { raw: Uint8Array; provider: string; providerId: string; receivedAt: Date }

/** Routes the mail to its user and runs intake for them; mail nobody claims is noted, not read. */
export async function intakeRawMail(deps: IntakeDeps, input: MailInput): Promise<IntakeResult> {
  const userId = await route(deps, input.raw)
  if (!userId) {
    await deps.tenancy.recordUnrouted({
      provider: input.provider,
      providerId: input.providerId,
      receivedAt: input.receivedAt,
    })
    return { outcome: 'unrouted' }
  }
  return intakeForUser(deps, userId, input)
}

/**
 * Intake for a user already known (also used to replay archived mail). Three steps, so no
 * database transaction is open while the file is stored or the bank's DNS key is fetched:
 *
 *   1. a short transaction: the mail's id, whether it is already recorded, the mailboxes;
 *   2. outside any transaction: store the sealed file (only if it was not recorded), then
 *      a short transaction records the mail and reads its verdict; then verify (DNS);
 *   3. a short transaction: the verdict, the parse and the ledger.
 *
 * The file is stored before the mail is recorded, so a recorded mail always has its file. Every
 * step is a no-op when already done, so a crash anywhere is repaired by running the same call
 * again.
 */
export async function intakeForUser(
  deps: IntakeDeps,
  userId: string,
  input: MailInput,
): Promise<IntakeResult> {
  const { tenancy } = deps
  const first = await tenancy.withUser(userId, async (ctx) => {
    const mailId = ctx.mailId(input.raw)
    return {
      mailId,
      store: ctx.store,
      mailboxes: ctx.mailboxes,
      recorded: await ctx.log.hasMail(mailId),
    }
  })
  const { mailId, store, mailboxes } = first
  const pathname = rawMailPathname(userId, mailId)
  const user = { userId, mailId }

  if (!first.recorded) await store.put(pathname, input.raw, 'message/rfc822')
  const final = await tenancy.withUser(userId, async (ctx) => {
    await ctx.log.recordMail({
      mailId,
      pathname,
      bytes: input.raw.byteLength,
      provider: input.provider,
      providerId: input.providerId,
      receivedAt: input.receivedAt,
    })
    const settled = await ctx.log.finalVerdict(mailId)
    const parsed = settled ? await ctx.log.hasParse(mailId, TEMPLATE_SET_VERSION) : false
    return { settled, done: settled?.verdict === 'rejected' || parsed }
  })
  if (final.done) return { ...user, outcome: 'duplicate' }

  const verdict = final.settled
    ? null
    : await verifyBankMail(input.raw, {
        senders: deps.senders,
        mailboxes,
        resolver: deps.resolver,
        receivedAt: input.receivedAt,
        maxDateSkewMinutes: deps.maxDateSkewMinutes,
      })

  return tenancy.withUser(userId, async (ctx): Promise<IntakeResult> => {
    if (verdict) await ctx.log.recordVerdict(mailId, verdict, SENDER_POLICY_VERSION)
    const settled = final.settled ?? (verdict?.verdict === 'verified' ? verdict : null)
    if (!settled || settled.verdict !== 'verified') {
      return {
        ...user,
        outcome: verdict?.verdict ?? 'rejected',
        ...(verdict && verdict.verdict !== 'verified' ? { reason: verdict.reason } : {}),
      }
    }
    const parsed = await parseBankMail(input.raw, settled)
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
  })
}

export type ReplayResult = {
  provider: string
  providerId: string
  outcome: IntakeResult['outcome'] | 'failed'
}

/**
 * Runs deliveries that were once unrouted through intake again, after their mailbox was
 * registered. Each is fetched from the provider again (nothing of the mail was kept), with its
 * original arrival time. Marks nothing: a delivery that now routes is recorded under its user,
 * and the operator's list of unrouted deliveries leaves out any with a recorded delivery, so
 * running this twice does the work once. A delivery that cannot be fetched is reported and
 * left for the next run.
 */
export async function replayUnrouted(
  deps: IntakeDeps,
  deliveries: readonly { provider: string; providerId: string }[],
  fetchMail: (providerId: string) => Promise<ReceivedMail>,
): Promise<ReplayResult[]> {
  const out: ReplayResult[] = []
  for (const d of deliveries) {
    if (d.provider !== 'resend') continue
    try {
      const mail = await fetchMail(d.providerId)
      const result = await intakeRawMail(deps, {
        raw: mail.raw,
        provider: d.provider,
        providerId: d.providerId,
        receivedAt: mail.receivedAt,
      })
      out.push({ provider: d.provider, providerId: d.providerId, outcome: result.outcome })
    } catch {
      out.push({ provider: d.provider, providerId: d.providerId, outcome: 'failed' })
    }
  }
  return out
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
