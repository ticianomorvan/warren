import { isNews, type Ledger, type RecordOptions, type RecordOutcome } from '../ledger'
import { canonicalUserId, UserErasedError } from '../user'
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
export async function intakeRawMail(
  deps: IntakeDeps,
  input: MailInput,
  options: RecordOptions,
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
  return intakeForUser(deps, userId, input, options)
}

/** What `ensureStored` leaves behind: the mail is stored and recorded, with what is known of it. */
type Stored = {
  mailId: string
  mailboxes: readonly string[]
  /** The 'verified' or 'rejected' verdict, if the mail already has one. */
  settled: FinalVerdict | null
  /** Rejected, or verified and parsed under the current templates: nothing left to do. */
  done: boolean
}

/**
 * Step 1: the sealed file is stored, then the mail is recorded, so a recorded mail always has
 * its file. A mail already recorded is not stored again (a second put would seal it afresh and
 * overwrite the file). No transaction is open while the file is put. If the user was erased
 * while it was, the file is deleted again (best effort) before the error goes on: the
 * erasure's own file sweep may already have run.
 */
async function ensureStored(deps: IntakeDeps, userId: string, input: MailInput): Promise<Stored> {
  const first = await deps.tenancy.withUser(userId, async (ctx) => {
    const mailId = ctx.mailId(input.raw)
    return {
      mailId,
      store: ctx.store,
      mailboxes: ctx.mailboxes,
      recorded: await ctx.log.hasMail(mailId),
    }
  })
  const { mailId, store } = first
  const pathname = rawMailPathname(userId, mailId)
  if (!first.recorded) await store.put(pathname, input.raw, 'message/rfc822')
  try {
    return await deps.tenancy.withUser(userId, async (ctx) => {
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
      return {
        mailId,
        mailboxes: first.mailboxes,
        settled,
        done: settled?.verdict === 'rejected' || parsed,
      }
    })
  } catch (error) {
    if (error instanceof UserErasedError) await store.deletePrefix(pathname).catch(() => {})
    throw error
  }
}

/**
 * Step 2: the verdict. Returns the one already settled, or checks the mail (DNS, outside any
 * transaction) and records what it found, in a short transaction of its own. Always returns a
 * verdict; 'retry' is recorded but is not final.
 */
async function settleVerdict(
  deps: IntakeDeps,
  userId: string,
  input: MailInput,
  stored: Stored,
): Promise<MailVerdict | FinalVerdict> {
  if (stored.settled) return stored.settled
  const verdict = await verifyBankMail(input.raw, {
    senders: deps.senders,
    mailboxes: stored.mailboxes,
    resolver: deps.resolver,
    receivedAt: input.receivedAt,
    maxDateSkewMinutes: deps.maxDateSkewMinutes,
  })
  await deps.tenancy.withUser(userId, (ctx) =>
    ctx.log.recordVerdict(stored.mailId, verdict, SENDER_POLICY_VERSION),
  )
  return verdict
}

/** Step 3: a short transaction that parses a verified mail and records its operation in the ledger. */
async function parseAndRecord(
  deps: IntakeDeps,
  userId: string,
  input: MailInput,
  mailId: string,
  verified: VerifiedMail,
  options: RecordOptions,
): Promise<IntakeResult> {
  const user = { userId, mailId }
  return deps.tenancy.withUser(userId, async (ctx): Promise<IntakeResult> => {
    const parsed = await parseBankMail(input.raw, verified)
    await ctx.log.recordParse(mailId, TEMPLATE_SET_VERSION, parsed)
    if (parsed.status === 'unparsed') {
      return { ...user, outcome: 'verified', parse: 'unparsed', parseReason: parsed.reason }
    }
    const recorded = await ctx.ledger.recordMailOperation(
      { mailId, templateId: parsed.templateId, operation: parsed.operation },
      options,
    )
    return { ...user, outcome: 'verified', parse: 'parsed', movement: recorded.outcome }
  })
}

/**
 * Intake for a user already known (also used to replay mail). Three steps, so no database
 * transaction is open while the file is stored or the bank's DNS key is fetched: `ensureStored`,
 * `settleVerdict`, `parseAndRecord`. Every step is a no-op when already done, so a crash anywhere
 * is repaired by running the same call again.
 *
 * `options.notify` says whether a movement the mail creates owes its user a notice. Live mail
 * passes true; a rebuild or an import (`mail:reingest`) replays old mail, and passes false.
 */
export async function intakeForUser(
  deps: IntakeDeps,
  id: string,
  input: MailInput,
  options: RecordOptions,
): Promise<IntakeResult> {
  const userId = canonicalUserId(id)
  const stored = await ensureStored(deps, userId, input)
  const user = { userId, mailId: stored.mailId }
  if (stored.done) return { ...user, outcome: 'duplicate' }

  const verdict = await settleVerdict(deps, userId, input, stored)
  if (verdict.verdict !== 'verified') {
    return {
      ...user,
      outcome: verdict.verdict,
      ...('reason' in verdict ? { reason: verdict.reason } : {}),
    }
  }
  return parseAndRecord(deps, userId, input, stored.mailId, verdict, options)
}

export type ReplayResult = {
  provider: string
  providerId: string
  outcome: IntakeResult['outcome'] | 'failed'
  /** For 'failed': the class of the error (its name), never its message, which could hold mail. */
  error?: string
}

/**
 * A replay result that leaves the delivery unfinished: the operator must run it again. Mail
 * that still matches no mailbox is not: it is addressed to nobody here (spam, a typo), so it is
 * reported and stays listed, without failing every later run.
 */
export const replayIncomplete = (r: ReplayResult): boolean =>
  r.outcome === 'retry' || r.outcome === 'failed'

/**
 * Runs deliveries that were once unrouted through intake again, after their mailbox was
 * registered. Each is fetched from the provider again (nothing of the mail was kept) and run
 * with its original arrival time, `receivedAt`. Marks nothing: a delivery that now routes is
 * recorded under its user, and the operator's list leaves out a delivery once its mail has a
 * final verdict, so running this twice does the work once. A delivery that cannot be fetched,
 * that is still unrouted, or whose verdict is 'retry' (DNS trouble) stays listed: see
 * `replayIncomplete`. The caller chooses which deliveries (a provider's) to pass.
 *
 * This replays real mail the user never saw, so a movement it creates is news and owes a notice,
 * unless the mail is older than the notice window (`isNews`): the outbox would send
 * that notice as if it were fresh, a day or a week late. Those movements are created silently.
 * (A rebuild from an archive is different: it replays what the user already saw, and passes
 * `notify: false` to `intakeForUser`.)
 */
export async function replayUnrouted(
  deps: IntakeDeps,
  deliveries: readonly { provider: string; providerId: string; receivedAt: Date }[],
  fetchMail: (providerId: string) => Promise<ReceivedMail>,
  now: () => Date = () => new Date(),
): Promise<ReplayResult[]> {
  const out: ReplayResult[] = []
  for (const d of deliveries) {
    try {
      const mail = await fetchMail(d.providerId)
      const result = await intakeRawMail(
        deps,
        {
          raw: mail.raw,
          provider: d.provider,
          providerId: d.providerId,
          receivedAt: d.receivedAt,
        },
        { notify: isNews(d.receivedAt, now()) },
      )
      out.push({ provider: d.provider, providerId: d.providerId, outcome: result.outcome })
    } catch (error) {
      out.push({
        provider: d.provider,
        providerId: d.providerId,
        outcome: 'failed',
        error: error instanceof Error ? error.name : 'unknown',
      })
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
  const result = await intakeRawMail(
    deps,
    {
      raw: mail.raw,
      provider: 'resend',
      providerId: event.emailId,
      receivedAt: mail.receivedAt,
    },
    // A retry after a long outage can bring day-old mail: the outbox would send it as news.
    { notify: isNews(mail.receivedAt, deps.now?.() ?? new Date()) },
  )
  return { status: result.outcome === 'retry' ? 503 : 200, body: result }
}
