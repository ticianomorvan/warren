import type { MailVerdict, NewMail } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../src/client'
import { createMailLog, verifiedMailOf } from '../src/mail-log'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string

const mail = (c: string): NewMail => ({
  mailId: sha(c),
  pathname: `u/x/mail/${sha(c)}.eml.sealed`,
  bytes: 10,
  provider: 'resend',
  providerId: `em_${c}`,
  receivedAt: new Date('2026-11-14T13:00:40Z'),
})
const verified = (subject: string, senderId = 'bbva-cards'): MailVerdict => ({
  verdict: 'verified',
  senderId,
  fromAddress: 'avisos@bbva.com.ar',
  signingDomain: 'bbva.com.ar',
  selector: 's1',
  keyRecord: 'v=DKIM1; p=abc',
  signedHeaders: ['date', 'from', 'to', 'subject'],
  subject,
  signedDate: new Date('2026-11-14T13:00:00Z'),
})
const rejected: MailVerdict = {
  verdict: 'rejected',
  reason: 'date-skew',
  fromAddress: 'avisos@bbva.com.ar',
  senderId: 'bbva-cards',
  detail: 'x',
}

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('verified-mail')
})

describe('verifiedMailOf', () => {
  it('returns one row per mail, and only mail whose latest verdict is verified', async () => {
    await asUser(t.app, user, async (scope) => {
      const log = createMailLog(scope)
      for (const c of ['a', 'b', 'c', 'd']) await log.recordMail(mail(c))
      // a: verified twice -> one row. b: verified, then rejected -> excluded.
      // c: rejected, then verified -> included. d: another sender.
      await log.recordVerdict(sha('a'), verified('Compra aprobada'), 1)
      await log.recordVerdict(sha('a'), verified('Compra aprobada'), 2)
      await log.recordVerdict(sha('b'), verified('Compra aprobada'), 1)
      await log.recordVerdict(sha('b'), rejected, 2)
      await log.recordVerdict(sha('c'), rejected, 1)
      await log.recordVerdict(sha('c'), verified('Compra aprobada'), 2)
      await log.recordVerdict(sha('d'), verified('Compra aprobada', 'bbva-transfers'), 1)
    })
    const rows = await asUser(t.app, user, (scope) => verifiedMailOf(scope, 'bbva-cards'))
    expect(rows.map((r) => r.mailId)).toEqual([sha('a'), sha('c')])
    expect(rows[0]).toMatchObject({ subject: 'Compra aprobada', senderId: 'bbva-cards' })
  })
})
