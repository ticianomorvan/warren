import { Webhook } from 'svix'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/hash'
import type { Ledger, ParsedMail } from '../src/ledger'
import {
  type FinalVerdict,
  handleResendWebhook,
  type MailLog,
  type NewMail,
  type PendingParse,
  parsePending,
  type RawStore,
  type ResendWebhookDeps,
} from '../src/mail/intake'
import type { ParseResult } from '../src/mail/parse'
import { verifyResendWebhook } from '../src/mail/resend'
import type { TxtResolver } from '../src/mail/resolver'
import { SENDERS } from '../src/mail/senders'
import type { MailVerdict } from '../src/mail/verify'
import { htmlMessage, transferSentHtml } from './fixtures'
import { failingResolver, makeSigner, message, OWNER, RECEIVED_AT, resolverFor } from './helpers'

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
  verdicts: { sha256: string; verdict: MailVerdict }[] = []
  async findDelivery(provider: string, providerId: string) {
    return this.deliveries.get(`${provider}:${providerId}`) ?? null
  }
  async recordMail(mail: NewMail) {
    if (!this.mails.has(mail.sha256)) this.mails.set(mail.sha256, mail)
    this.deliveries.set(`${mail.provider}:${mail.providerId}`, mail.sha256)
  }
  parses = new Map<string, ParseResult>()
  async finalVerdict(sha256: string): Promise<FinalVerdict | null> {
    const v = this.verdicts.findLast(
      (x) => x.sha256 === sha256 && x.verdict.verdict !== 'retry',
    )?.verdict
    if (!v) return null
    return v.verdict === 'verified'
      ? { verdict: 'verified', senderId: v.senderId, subject: v.subject, signedDate: v.signedDate }
      : { verdict: 'rejected' }
  }
  async recordVerdict(sha256: string, verdict: MailVerdict) {
    this.verdicts.push({ sha256, verdict })
  }
  async hasParse(sha256: string, set: number) {
    return this.parses.has(`${sha256}:${set}`)
  }
  async recordParse(sha256: string, set: number, result: ParseResult) {
    if (!this.parses.has(`${sha256}:${set}`)) this.parses.set(`${sha256}:${set}`, result)
  }
  async pendingParses(set: number): Promise<PendingParse[]> {
    const out: PendingParse[] = []
    for (const [sha256, mail] of this.mails) {
      const final = await this.finalVerdict(sha256)
      if (final?.verdict === 'verified' && !this.parses.has(`${sha256}:${set}`)) {
        out.push({
          sha256,
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
    const seen = this.recorded.some((m) => m.mailSha256 === mail.mailSha256)
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

async function setup(resolver?: TxtResolver, unsigned = message()) {
  const raw = new TextEncoder().encode(await bank.sign(unsigned))
  const files = new Map<string, Uint8Array>()
  const store: RawStore = {
    put: async (p, b) => void files.set(p, b),
    get: async (p) => files.get(p) ?? null,
  }
  const log = new MemoryLog()
  const ledger = new MemoryLedger()
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
  const deps: ResendWebhookDeps = {
    store,
    log,
    ledger,
    resolver: resolver ?? resolverFor({ [bank.dnsName]: bank.record }),
    senders: SENDERS,
    ownerAddresses: [OWNER],
    maxDateSkewMinutes: 120,
    webhookSecret: SECRET,
    apiKey: 're_test',
    fetchFn,
    now: () => NOW,
  }
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } })
  return { deps, body, raw, files, log, ledger, calls }
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
  it('stores, records and verifies a forwarded bank mail', async () => {
    const { deps, body, raw, files, log } = await setup()
    const res = await handleResendWebhook(deps, body, signedHeaders(body))
    const sha = sha256Hex(raw)
    expect(res).toEqual({
      status: 200,
      body: { sha256: sha, outcome: 'verified', parse: 'unparsed', parseReason: 'no-html' },
    })
    expect(files.get(`raw/mail/${sha}.eml`)).toEqual(raw)
    expect(log.mails.get(sha)).toMatchObject({
      provider: 'resend',
      providerId: 'em_1',
      bytes: raw.length,
    })
    expect(log.verdicts).toHaveLength(1)
  })

  it('does nothing the second time, without calling Resend again', async () => {
    const { deps, body, log, calls } = await setup()
    await handleResendWebhook(deps, body, signedHeaders(body))
    const before = calls.length
    const res = await handleResendWebhook(deps, body, signedHeaders(body, 'msg_retry'))
    expect(res.body.outcome).toBe('duplicate')
    expect(calls.length).toBe(before)
    expect(log.verdicts).toHaveLength(1)
  })

  it('refuses an unsigned call before touching anything', async () => {
    const { deps, body, calls, log } = await setup()
    const res = await handleResendWebhook(deps, body, {
      id: 'x',
      timestamp: '1',
      signature: 'v1,AAAA',
    })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(log.mails.size).toBe(0)
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
    const { deps, body, log, files } = await setup(failingResolver)
    const first = await handleResendWebhook(deps, body, signedHeaders(body))
    expect(first.status).toBe(503)
    expect(files.size).toBe(1)
    expect(log.mails.size).toBe(1)
    const healthy = { ...deps, resolver: resolverFor({ [bank.dnsName]: bank.record }) }
    const second = await handleResendWebhook(healthy, body, signedHeaders(body, 'msg_2'))
    expect(second.body.outcome).toBe('verified')
    expect(log.verdicts.map((v) => v.verdict.verdict)).toEqual(['retry', 'verified'])
  })

  it('parses a verified transfer mail into an operation', async () => {
    const unsigned = htmlMessage('Realizaste una transferencia', transferSentHtml(), OWNER)
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
    const unsigned = htmlMessage('Realizaste una transferencia', transferSentHtml(), OWNER)
    const { deps, body, log } = await setup(undefined, unsigned)
    await handleResendWebhook(deps, body, signedHeaders(body))
    log.parses.clear()
    const results = await parsePending(deps)
    expect(results).toMatchObject([{ status: 'parsed' }])
    expect(log.parses.size).toBe(1)
    expect(await parsePending(deps)).toEqual([])
  })
})
