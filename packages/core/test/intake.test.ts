import { Webhook } from 'svix'
import { describe, expect, it } from 'vitest'
import { mailId as keyedMailId, newDataKey, sealerFor } from '../src/crypto'
import type { Ledger, ParsedMail } from '../src/ledger'
import {
  type FinalVerdict,
  handleResendWebhook,
  intakeForUser,
  intakeRawMail,
  type MailLog,
  type NewMail,
  type PendingParse,
  parsePending,
  type RawStore,
  type ResendWebhookDeps,
  rawMailPathname,
  replayIncomplete,
  replayUnrouted,
  type Tenancy,
  type UserContext,
  userFilesPrefix,
} from '../src/mail/intake'
import type { ParseResult } from '../src/mail/parse'
import { verifyResendWebhook } from '../src/mail/resend'
import type { TxtResolver } from '../src/mail/resolver'
import { SENDERS } from '../src/mail/senders'
import type { MailVerdict } from '../src/mail/verify'
import { UserErasedError } from '../src/user'
import { htmlMessage, transferSentHtml } from './fixtures'
import { failingResolver, MAILBOX, makeSigner, message, RECEIVED_AT, resolverFor } from './helpers'

const SECRET = `whsec_${Buffer.from('a-test-secret-of-24-bytes').toString('base64')}`
const NOW = new Date('2026-11-14T13:01:00Z')
const bank = makeSigner('bbva.com.ar')

function signedHeaders(body: string, id = 'msg_1', at = NOW) {
  const signature = new Webhook(SECRET).sign(id, at, body)
  return { id, timestamp: String(Math.floor(at.getTime() / 1000)), signature }
}

class MemoryLog implements MailLog {
  mails = new Map<string, NewMail>()
  deliveries = new Map<string, string>()
  verdicts: { mailId: string; verdict: MailVerdict }[] = []
  async hasMail(mailId: string) {
    return this.mails.has(mailId)
  }
  async recordMail(mail: NewMail) {
    if (!this.mails.has(mail.mailId)) this.mails.set(mail.mailId, mail)
    this.deliveries.set(`${mail.provider}:${mail.providerId}`, mail.mailId)
  }
  parses = new Map<string, ParseResult>()
  async finalVerdict(mailId: string): Promise<FinalVerdict | null> {
    const v = this.verdicts.findLast(
      (x) => x.mailId === mailId && x.verdict.verdict !== 'retry',
    )?.verdict
    if (!v) return null
    return v.verdict === 'verified'
      ? { verdict: 'verified', senderId: v.senderId, subject: v.subject, signedDate: v.signedDate }
      : { verdict: 'rejected' }
  }
  async recordVerdict(mailId: string, verdict: MailVerdict) {
    this.verdicts.push({ mailId, verdict })
  }
  async hasParse(mailId: string, set: number) {
    return this.parses.has(`${mailId}:${set}`)
  }
  async recordParse(mailId: string, set: number, result: ParseResult) {
    if (!this.parses.has(`${mailId}:${set}`)) this.parses.set(`${mailId}:${set}`, result)
  }
  async pendingParses(set: number): Promise<PendingParse[]> {
    const out: PendingParse[] = []
    for (const [mailId, mail] of this.mails) {
      const final = await this.finalVerdict(mailId)
      if (final?.verdict === 'verified' && !this.parses.has(`${mailId}:${set}`)) {
        out.push({
          mailId,
          pathname: mail.pathname,
          senderId: final.senderId,
          subject: final.subject,
          signedDate: final.signedDate,
        })
      }
    }
    return out
  }
}

class MemoryLedger implements Ledger {
  recorded: ParsedMail[] = []
  async recordMailOperation(mail: ParsedMail) {
    const seen = this.recorded.some((m) => m.mailId === mail.mailId)
    if (!seen) this.recorded.push(mail)
    return {
      movementId: 'm1',
      outcome: seen ? ('duplicate' as const) : ('created' as const),
      type: 'unclassified' as const,
    }
  }
  async pendingMailOperations() {
    return []
  }
}

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

/** In-memory tenancy: each user has their own key, log, ledger and files. */
class MemoryTenancy implements Tenancy {
  files = new Map<string, Uint8Array>()
  /** True while a `withUser` callback runs: file and network I/O must never happen then. */
  inTx = false
  /** Where a file was stored or a DNS key fetched, with whether a transaction was open. */
  io: { what: string; inTx: boolean }[] = []
  puts = 0
  /** Simulates the erasure committing while a file is being put: later transactions throw. */
  eraseDuringPut = false
  erased = false
  unrouted: { provider: string; providerId: string; receivedAt: Date }[] = []
  users = new Map<string, { key: Buffer; log: MemoryLog; ledger: MemoryLedger }>()
  constructor(readonly mailboxes: Record<string, string>) {
    for (const id of Object.values(mailboxes)) {
      this.users.set(id, { key: newDataKey(), log: new MemoryLog(), ledger: new MemoryLedger() })
    }
  }
  user(id: string) {
    const u = this.users.get(id)
    if (!u) throw new Error('unknown user')
    return u
  }
  async userForMailbox(address: string) {
    return this.mailboxes[address.toLowerCase()] ?? null
  }
  async recordUnrouted(d: { provider: string; providerId: string; receivedAt: Date }) {
    this.unrouted.push(d)
  }
  async withUser<T>(userId: string, fn: (ctx: UserContext) => Promise<T>) {
    if (this.erased) throw new UserErasedError()
    const { key, log, ledger } = this.user(userId)
    const sealer = sealerFor(userId, key)
    const store: RawStore = {
      put: async (p, b) => {
        this.io.push({ what: 'put', inTx: this.inTx })
        this.puts++
        if (this.eraseDuringPut) this.erased = true
        this.files.set(p, sealer.seal(b, `blob:${p}`))
      },
      get: async (p) => {
        const sealed = this.files.get(p)
        return sealed ? sealer.open(sealed, `blob:${p}`) : null
      },
      deletePrefix: async (prefix) => {
        const gone = [...this.files.keys()].filter((p) => p.startsWith(prefix))
        for (const p of gone) this.files.delete(p)
        return gone.length
      },
    }
    const mailboxes = Object.entries(this.mailboxes)
      .filter(([, id]) => id === userId)
      .map(([address]) => address)
    this.inTx = true
    try {
      return await fn({ userId, store, log, ledger, mailboxes, mailId: sealer.mailId })
    } finally {
      this.inTx = false
    }
  }
}

async function setup(resolver?: TxtResolver, unsigned = message()) {
  const raw = new TextEncoder().encode(await bank.sign(unsigned))
  const tenancy = new MemoryTenancy({ [MAILBOX]: USER, 'other@example.com': OTHER })
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push(u)
    if (u === 'https://api.resend.com/emails/receiving/em_1') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_test')
      return Response.json({
        id: 'em_1',
        created_at: RECEIVED_AT.toISOString(),
        raw: { download_url: 'https://cdn.example/raw/em_1' },
      })
    }
    if (u === 'https://cdn.example/raw/em_1') return new Response(raw)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const dns = resolver ?? resolverFor({ [bank.dnsName]: bank.record })
  const deps: ResendWebhookDeps = {
    tenancy,
    resolver: async (name, rrtype) => {
      tenancy.io.push({ what: 'dns', inTx: tenancy.inTx })
      return dns(name, rrtype)
    },
    senders: SENDERS,
    maxDateSkewMinutes: 120,
    webhookSecret: SECRET,
    apiKey: 're_test',
    fetchFn,
    now: () => NOW,
  }
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } })
  const { log, ledger, key } = tenancy.user(USER)
  const mailId = keyedMailId(key, raw)
  return { deps, body, raw, tenancy, log, ledger, calls, mailId, key }
}

describe('verifyResendWebhook', () => {
  it('agrees with the svix library and rejects tampering', () => {
    const body = '{"type":"email.received"}'
    const h = signedHeaders(body)
    expect(verifyResendWebhook(body, h, SECRET, NOW)).toBe(true)
    expect(verifyResendWebhook(`${body} `, h, SECRET, NOW)).toBe(false)
    expect(verifyResendWebhook(body, { ...h, id: 'msg_2' }, SECRET, NOW)).toBe(false)
    expect(verifyResendWebhook(body, h, SECRET, new Date(NOW.getTime() + 6 * 60_000))).toBe(false)
    expect(verifyResendWebhook(body, { ...h, signature: null }, SECRET, NOW)).toBe(false)
  })
})

describe('handleResendWebhook', () => {
  it('stores sealed, records and verifies a forwarded bank mail', async () => {
    const { deps, body, raw, tenancy, log, mailId } = await setup()
    const res = await handleResendWebhook(deps, body, signedHeaders(body))
    expect(res).toEqual({
      status: 200,
      body: {
        userId: USER,
        mailId,
        outcome: 'verified',
        parse: 'unparsed',
        parseReason: 'no-html',
      },
    })
    const path = rawMailPathname(USER, mailId)
    expect(path).toBe(`u/${USER}/mail/${mailId}.eml.sealed`)
    const stored = tenancy.files.get(path)
    expect(stored).toBeDefined()
    // What sits in the store is ciphertext: nothing of the mail shows through.
    expect(Buffer.from(stored ?? []).includes(Buffer.from('Transferiste'))).toBe(false)
    expect(Buffer.from(stored ?? []).includes(Buffer.from(raw.subarray(0, 40)))).toBe(false)
    expect(log.mails.get(mailId)).toMatchObject({
      provider: 'resend',
      providerId: 'em_1',
      bytes: raw.length,
      pathname: path,
    })
    expect(log.verdicts).toHaveLength(1)
  })

  it('names a mail by a keyed hash, so two users get different ids for the same bytes', async () => {
    const { raw, key } = await setup()
    const a = keyedMailId(key, raw)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(keyedMailId(newDataKey(), raw)).not.toBe(a)
    expect(keyedMailId(key, raw)).toBe(a)
  })

  it('does nothing the second time except fetch the mail again', async () => {
    const { deps, body, log } = await setup()
    await handleResendWebhook(deps, body, signedHeaders(body))
    const res = await handleResendWebhook(deps, body, signedHeaders(body, 'msg_retry'))
    expect(res.body.outcome).toBe('duplicate')
    expect(log.verdicts).toHaveLength(1)
  })

  it('notes mail nobody claims without content, and answers 200 so it is not retried', async () => {
    const { deps, body, tenancy } = await setup(undefined, message({ to: 'stranger@example.com' }))
    const res = await handleResendWebhook(deps, body, signedHeaders(body))
    expect(res).toEqual({ status: 200, body: { outcome: 'unrouted' } })
    expect(tenancy.unrouted).toEqual([
      { provider: 'resend', providerId: 'em_1', receivedAt: RECEIVED_AT },
    ])
    expect(tenancy.files.size).toBe(0)
    for (const u of tenancy.users.values()) expect(u.log.mails.size).toBe(0)
  })

  it('routes by the unsigned To, then rule 4 decides: a signed To naming someone else is rejected', async () => {
    // Signed To names the other user; an unsigned To header added in transit points at USER.
    const signed = await bank.sign(message({ to: 'other@example.com' }))
    const forged = `To: ${MAILBOX}\r\n${signed}`
    const { deps, body, tenancy } = await setup()
    const raw = new TextEncoder().encode(forged)
    const fetchFn = (async (url: string | URL | Request) =>
      String(url).includes('api.resend.com')
        ? Response.json({
            id: 'em_1',
            created_at: RECEIVED_AT.toISOString(),
            raw: { download_url: 'https://cdn.example/raw/em_1' },
          })
        : new Response(raw)) as typeof fetch
    const res = await handleResendWebhook({ ...deps, fetchFn }, body, signedHeaders(body))
    expect(res.body).toMatchObject({
      userId: USER,
      outcome: 'rejected',
      reason: 'not-addressed-to-user',
    })
    // It was checked in USER's ledger only; the other user has nothing.
    expect(tenancy.user(OTHER).log.mails.size).toBe(0)
  })

  it('refuses an unsigned call before touching anything', async () => {
    const { deps, body, calls, tenancy } = await setup()
    const res = await handleResendWebhook(deps, body, {
      id: 'x',
      timestamp: '1',
      signature: 'v1,AAAA',
    })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(tenancy.files.size).toBe(0)
  })

  it('ignores other event types', async () => {
    const { deps, calls } = await setup()
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'em_1' } })
    expect(await handleResendWebhook(deps, body, signedHeaders(body))).toEqual({
      status: 200,
      body: { ignored: true },
    })
    expect(calls).toHaveLength(0)
  })

  it('keeps the mail and asks Resend to retry when DNS is down, then finishes', async () => {
    const { deps, body, log, tenancy } = await setup(failingResolver)
    const first = await handleResendWebhook(deps, body, signedHeaders(body))
    expect(first.status).toBe(503)
    expect(tenancy.files.size).toBe(1)
    expect(log.mails.size).toBe(1)
    const healthy = { ...deps, resolver: resolverFor({ [bank.dnsName]: bank.record }) }
    const second = await handleResendWebhook(healthy, body, signedHeaders(body, 'msg_2'))
    expect(second.body.outcome).toBe('verified')
    expect(log.verdicts.map((v) => v.verdict.verdict)).toEqual(['retry', 'verified'])
  })

  it('parses a verified transfer mail into an operation', async () => {
    const unsigned = htmlMessage('Realizaste una transferencia', transferSentHtml(), MAILBOX)
    const { deps, body, log, ledger } = await setup(undefined, unsigned)
    const res = await handleResendWebhook(deps, body, signedHeaders(body))
    expect(res.body).toMatchObject({ outcome: 'verified', parse: 'parsed', movement: 'created' })
    expect(ledger.recorded).toMatchObject([
      { templateId: 'bbva.transfer-sent', operation: { amount: '12345.60' } },
    ])
    expect([...log.parses.values()][0]).toMatchObject({
      templateId: 'bbva.transfer-sent',
      operation: { amount: '12345.60' },
    })
  })

  it('parses stored mail that was verified before it could be parsed', async () => {
    const unsigned = htmlMessage('Realizaste una transferencia', transferSentHtml(), MAILBOX)
    const { deps, body, log, tenancy } = await setup(undefined, unsigned)
    await handleResendWebhook(deps, body, signedHeaders(body))
    log.parses.clear()
    const results = await tenancy.withUser(USER, (ctx) => parsePending(ctx))
    expect(results).toMatchObject([{ status: 'parsed' }])
    expect(log.parses.size).toBe(1)
    expect(await tenancy.withUser(USER, (ctx) => parsePending(ctx))).toEqual([])
  })

  it('opens no transaction around file or DNS work', async () => {
    const { deps, body, tenancy } = await setup()
    await handleResendWebhook(deps, body, signedHeaders(body))
    expect(tenancy.io.map((e) => e.what)).toEqual(['put', 'dns'])
    expect(tenancy.io.every((e) => !e.inTx)).toBe(true)
  })

  it('stores a mail once: a redelivery does not seal and upload it again', async () => {
    const { deps, body, tenancy, mailId } = await setup()
    await handleResendWebhook(deps, body, signedHeaders(body))
    const path = rawMailPathname(USER, mailId)
    const stored = tenancy.files.get(path)
    expect(tenancy.puts).toBe(1)
    // Resend redelivers the same event, and a second delivery of the same mail has a new id.
    await handleResendWebhook(deps, body, signedHeaders(body, 'msg_retry'))
    expect(tenancy.puts).toBe(1)
    expect(tenancy.files.get(path)).toBe(stored)
  })

  it('is repaired by running it again when it stopped after storing the file', async () => {
    const { deps, body, tenancy, log } = await setup()
    const record = log.recordMail.bind(log)
    log.recordMail = async () => {
      throw new Error('database went away')
    }
    await expect(handleResendWebhook(deps, body, signedHeaders(body))).rejects.toThrow(
      /database went away/,
    )
    expect(tenancy.files.size).toBe(1)
    expect(log.mails.size).toBe(0)
    log.recordMail = record
    const res = await handleResendWebhook(deps, body, signedHeaders(body, 'msg_2'))
    expect(res.body.outcome).toBe('verified')
    expect(log.mails.size).toBe(1)
    expect(log.verdicts).toHaveLength(1)
  })

  it('is repaired by running it again when it stopped after recording the mail', async () => {
    const { deps, body, log } = await setup()
    const verdict = log.recordVerdict.bind(log)
    log.recordVerdict = async () => {
      throw new Error('crashed before the verdict')
    }
    await expect(handleResendWebhook(deps, body, signedHeaders(body))).rejects.toThrow(/crashed/)
    expect(log.mails.size).toBe(1)
    expect(log.verdicts).toHaveLength(0)
    log.recordVerdict = verdict
    const res = await handleResendWebhook(deps, body, signedHeaders(body, 'msg_2'))
    expect(res.body.outcome).toBe('verified')
    expect(log.verdicts).toHaveLength(1)
  })

  it('deletes the file it stored when the user was erased meanwhile, then fails', async () => {
    const { deps, tenancy, raw } = await setup()
    tenancy.eraseDuringPut = true
    await expect(
      intakeForUser(deps, USER, {
        raw,
        provider: 'resend',
        providerId: 'em_1',
        receivedAt: RECEIVED_AT,
      }),
    ).rejects.toBeInstanceOf(UserErasedError)
    expect(tenancy.puts).toBe(1)
    expect(tenancy.files.size).toBe(0)
  })

  it('uses one spelling of the user id for the file path', async () => {
    const lower = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
    const { deps, raw } = await setup()
    const tenancy = new MemoryTenancy({ [MAILBOX]: lower })
    const mailId = keyedMailId(tenancy.user(lower).key, raw)
    await intakeForUser({ ...deps, tenancy }, lower.toUpperCase(), {
      raw,
      provider: 'resend',
      providerId: 'em_1',
      receivedAt: RECEIVED_AT,
    })
    expect([...tenancy.files.keys()]).toEqual([rawMailPathname(lower, mailId)])
  })

  it("deletes one user's files by prefix and no one else's", async () => {
    const { deps, body, tenancy } = await setup()
    await handleResendWebhook(deps, body, signedHeaders(body))
    tenancy.files.set(`u/${OTHER}/mail/keep.eml.sealed`, new Uint8Array([1]))
    const gone = await tenancy.withUser(USER, (ctx) =>
      ctx.store.deletePrefix(userFilesPrefix(USER)),
    )
    expect(gone).toBe(1)
    expect([...tenancy.files.keys()]).toEqual([`u/${OTHER}/mail/keep.eml.sealed`])
  })
})

describe('replayUnrouted', () => {
  it('runs mail that was unrouted through intake once its mailbox exists, and says what it did', async () => {
    const { deps, raw, tenancy, log } = await setup()
    // The mailbox was not registered when the mail first arrived.
    const before = new MemoryTenancy({})
    expect(await intakeRawMail({ ...deps, tenancy: before }, input(raw))).toEqual({
      outcome: 'unrouted',
    })
    expect(before.unrouted).toHaveLength(1)

    const fetched: string[] = []
    const fetchMail = async (id: string) => {
      fetched.push(id)
      return { raw, receivedAt: RECEIVED_AT }
    }
    const pending = [{ provider: 'resend', providerId: 'em_1', receivedAt: RECEIVED_AT }]
    const first = await replayUnrouted(deps, pending, fetchMail)
    expect(first).toEqual([{ provider: 'resend', providerId: 'em_1', outcome: 'verified' }])
    expect(log.mails.size).toBe(1)
    expect(tenancy.unrouted).toEqual([])

    // Again: same delivery, so a duplicate and no second record.
    const second = await replayUnrouted(deps, pending, fetchMail)
    expect(second[0]?.outcome).toBe('duplicate')
    expect(log.verdicts).toHaveLength(1)
  })

  it('leaves a delivery that cannot be fetched for the next run, naming the error class only', async () => {
    const { deps } = await setup()
    const gone = { provider: 'resend', providerId: 'em_gone', receivedAt: RECEIVED_AT }
    const out = await replayUnrouted(deps, [gone], async () => {
      throw new TypeError('Resend API 404 for ticiano@example.com')
    })
    expect(out).toEqual([
      { provider: 'resend', providerId: 'em_gone', outcome: 'failed', error: 'TypeError' },
    ])
    expect(JSON.stringify(out)).not.toContain('ticiano')
    expect(out.every(replayIncomplete)).toBe(true)
  })

  it("runs each delivery with the arrival time that was noted, not the fetched mail's", async () => {
    const { deps, raw } = await setup()
    // Noted three weeks before the signed date: the date check must see that time.
    const early = new Date('2026-10-20T13:00:00Z')
    const fetchMail = async () => ({ raw, receivedAt: RECEIVED_AT })
    const out = await replayUnrouted(
      deps,
      [{ provider: 'resend', providerId: 'em_1', receivedAt: early }],
      fetchMail,
    )
    expect(out[0]?.outcome).toBe('rejected')
  })

  it('leaves the choice of provider to the caller', async () => {
    const { deps, raw, log } = await setup()
    const out = await replayUnrouted(
      deps,
      [{ provider: 'other', providerId: 'x_1', receivedAt: RECEIVED_AT }],
      async () => ({ raw, receivedAt: RECEIVED_AT }),
    )
    expect(out[0]?.outcome).toBe('verified')
    expect(log.mails.size).toBe(1)
  })

  it('reports a delivery whose verdict is retry as incomplete, and finishes it next time', async () => {
    const { deps, raw, log } = await setup(failingResolver)
    const d = { provider: 'resend', providerId: 'em_1', receivedAt: RECEIVED_AT }
    const fetchMail = async () => ({ raw, receivedAt: RECEIVED_AT })
    const first = await replayUnrouted(deps, [d], fetchMail)
    expect(first[0]?.outcome).toBe('retry')
    expect(first.some(replayIncomplete)).toBe(true)
    const healthy = { ...deps, resolver: resolverFor({ [bank.dnsName]: bank.record }) }
    const second = await replayUnrouted(healthy, [d], fetchMail)
    expect(second[0]?.outcome).toBe('verified')
    expect(second.some(replayIncomplete)).toBe(false)
    expect(log.verdicts.map((v) => v.verdict.verdict)).toEqual(['retry', 'verified'])
  })
})

describe('replayIncomplete', () => {
  const r = (outcome: Parameters<typeof replayIncomplete>[0]['outcome']) =>
    replayIncomplete({ provider: 'resend', providerId: 'x', outcome })
  it('is true for retry, unrouted and failed only', () => {
    expect(['retry', 'unrouted', 'failed'].map((o) => r(o as never))).toEqual([true, true, true])
    expect(['verified', 'rejected', 'duplicate'].map((o) => r(o as never))).toEqual([
      false,
      false,
      false,
    ])
  })
})

const input = (raw: Uint8Array) => ({
  raw,
  provider: 'resend',
  providerId: 'em_1',
  receivedAt: RECEIVED_AT,
})
