import { beforeAll, describe, expect, it } from 'vitest'
import { SENDERS } from '../src/mail/senders'
import { type VerifyOptions, verifySignedMail } from '../src/mail/verify'
import { failingResolver, MAILBOX, makeSigner, message, RECEIVED_AT, resolverFor } from './helpers'

const bank = makeSigner('bbva.com.ar')
const other = makeSigner('evil.example')
let opts: VerifyOptions

beforeAll(() => {
  opts = {
    senders: SENDERS,
    mailboxes: [MAILBOX],
    resolver: resolverFor({ [bank.dnsName]: bank.record, [other.dnsName]: other.record }),
    receivedAt: RECEIVED_AT,
    maxDateSkewMinutes: 120,
  }
})

const bytes = (s: string) => new TextEncoder().encode(s)

describe('verifySignedMail', () => {
  it('accepts a genuine bank mail addressed to the user', async () => {
    const v = await verifySignedMail(bytes(await bank.sign(message())), opts)
    expect(v).toMatchObject({
      verdict: 'verified',
      senderId: 'bbva-transfers',
      signingDomain: 'bbva.com.ar',
      selector: 'test1',
      subject: 'Realizaste una transferencia',
      keyRecord: bank.record,
    })
  })

  it('accepts when a forwarder prepends its own headers', async () => {
    const signed = await bank.sign(message())
    const forwarded = `Received: by mx.example with SMTP id 1\r\nX-Forwarded-To: in@x.resend.app\r\n${signed}`
    expect((await verifySignedMail(bytes(forwarded), opts)).verdict).toBe('verified')
  })

  it('rejects a changed body', async () => {
    const signed = (await bank.sign(message())).replace('1.000,00', '9.000,00')
    expect(await verifySignedMail(bytes(signed), opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'signature-failed',
    })
  })

  it('rejects mail signed only by someone else claiming the bank address', async () => {
    const signed = await other.sign(message())
    expect(await verifySignedMail(bytes(signed), opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'no-signature-from-sender',
    })
  })

  it('rejects an unknown sender even with a valid signature', async () => {
    const signed = await other.sign(message({ from: 'x@evil.example' }))
    expect(await verifySignedMail(bytes(signed), opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'unknown-sender',
    })
  })

  it('names the sender only once the From address matched the allow-list', async () => {
    const stranger = await verifySignedMail(
      bytes(await other.sign(message({ from: 'x@evil.example' }))),
      opts,
    )
    expect(stranger).not.toHaveProperty('senderId')
    const forged = await verifySignedMail(bytes(await other.sign(message())), opts)
    expect(forged).toMatchObject({ reason: 'no-signature-from-sender', senderId: 'bbva-transfers' })
    const dns = await verifySignedMail(bytes(await bank.sign(message())), {
      ...opts,
      resolver: failingResolver,
    })
    expect(dns).toMatchObject({ verdict: 'retry', senderId: 'bbva-transfers' })
  })

  it('rejects genuine bank mail addressed to someone else, even with an unsigned To added', async () => {
    const signed = await bank.sign(message({ to: 'stranger@example.com' }))
    const replayed = `To: ${MAILBOX}\r\n${signed}`
    expect(await verifySignedMail(bytes(replayed), opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'not-addressed-to-user',
    })
  })

  it('rejects when a required header is not signed', async () => {
    const signed = await bank.sign(message(), 'From:Subject:Date')
    expect(await verifySignedMail(bytes(signed), opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'header-not-signed',
      detail: 'to',
    })
  })

  it('rejects an old mail replayed now, unless the skew check is off', async () => {
    const signed = bytes(await bank.sign(message({ date: 'Mon, 02 Nov 2026 10:00:00 -0300' })))
    expect(await verifySignedMail(signed, opts)).toMatchObject({
      verdict: 'rejected',
      reason: 'date-skew',
    })
    expect((await verifySignedMail(signed, { ...opts, maxDateSkewMinutes: null })).verdict).toBe(
      'verified',
    )
  })

  it('rejects two From headers', async () => {
    const signed = `From: x@evil.example\r\n${await bank.sign(message())}`
    expect(await verifySignedMail(bytes(signed), opts)).toMatchObject({ reason: 'from-invalid' })
  })

  it('asks for a retry, never a rejection, when DNS is down', async () => {
    const signed = bytes(await bank.sign(message()))
    expect(await verifySignedMail(signed, { ...opts, resolver: failingResolver })).toMatchObject({
      verdict: 'retry',
    })
  })
})
