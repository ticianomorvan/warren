import type { MailVerdict, NewMail } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inUserContext, type Scope } from '../src/client'
import { createMailLog, mailCounts, recentMail } from '../src/mail-log'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)
const log = <T>(fn: (log: ReturnType<typeof createMailLog>) => Promise<T>) =>
  as((scope) => fn(createMailLog(scope)))

const mail = (c: string, providerId: string): NewMail => ({
  mailId: sha(c),
  pathname: `u/x/mail/${sha(c)}.eml.sealed`,
  bytes: 1234,
  provider: 'resend',
  providerId,
  receivedAt: new Date('2026-11-14T13:00:40Z'),
})
const verified: MailVerdict = {
  verdict: 'verified',
  senderId: 'bbva-transfers',
  fromAddress: 'avisos@bbva.com.ar',
  signingDomain: 'bbva.com.ar',
  selector: 's1',
  keyRecord: 'v=DKIM1; p=abc',
  signedHeaders: ['date', 'from', 'to', 'subject'],
  subject: 'Realizaste una transferencia',
  signedDate: new Date('2026-11-14T13:00:00Z'),
}

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('mail')
})

describe('mail log', () => {
  it('records a mail once, however many times it is delivered', async () => {
    await log((l) => l.recordMail(mail('a', 'em_1')))
    await log((l) => l.recordMail(mail('a', 'em_1')))
    await log((l) => l.recordMail(mail('a', 'em_2')))
    expect(await log((l) => l.hasMail(sha('a')))).toBe(true)
    expect(await log((l) => l.hasMail(sha('f')))).toBe(false)
    const { rows } = await t.pg.query<{ n: number }>('select count(*)::int n from inbound_mail')
    expect(rows[0]?.n).toBe(1)
  })

  it('treats retry as not final, verified and rejected as final', async () => {
    await log((l) =>
      l.recordVerdict(
        sha('a'),
        { verdict: 'retry', reason: 'dns-temperror', fromAddress: null },
        1,
      ),
    )
    expect(await log((l) => l.finalVerdict(sha('a')))).toBeNull()
    await log((l) => l.recordVerdict(sha('a'), verified, 1))
    expect(await log((l) => l.finalVerdict(sha('a')))).toEqual({
      verdict: 'verified',
      senderId: 'bbva-transfers',
      subject: 'Realizaste una transferencia',
      signedDate: new Date('2026-11-14T13:00:00Z'),
    })

    await log((l) => l.recordMail(mail('b', 'em_3')))
    await log((l) =>
      l.recordVerdict(
        sha('b'),
        {
          verdict: 'rejected',
          reason: 'date-skew',
          fromAddress: 'avisos@bbva.com.ar',
          detail: '900 min',
        },
        1,
      ),
    )
    expect(await log((l) => l.finalVerdict(sha('b')))).toEqual({ verdict: 'rejected' })
  })

  it('lists each mail with its latest status, opening the sealed fields', async () => {
    const rows = await as((scope) => recentMail(scope))
    const a = rows.find((r) => r.mailId === sha('a'))
    const b = rows.find((r) => r.mailId === sha('b'))
    expect(a).toMatchObject({
      verdict: 'verified',
      senderId: 'bbva-transfers',
      subject: 'Realizaste una transferencia',
      attempts: 2,
    })
    expect(b).toMatchObject({
      verdict: 'rejected',
      reason: 'date-skew',
      detail: '900 min',
      attempts: 1,
    })
    expect(await as((scope) => mailCounts(scope))).toEqual({
      mails: 2,
      verified: 1,
      rejected: 1,
      parsed: 0,
    })
  })

  it('counts mail in the database: no sealed column is opened to do it', async () => {
    const expected = await as((scope) => mailCounts(scope))
    const counted = await as((scope) =>
      mailCounts({
        ...scope,
        open: () => {
          throw new Error('mailCounts must not open anything')
        },
      }),
    )
    expect(counted).toEqual(expected)
    expect(counted.mails).toBeGreaterThan(0)
  })

  it('records one parse per mail and template set, and lists what is pending', async () => {
    expect((await log((l) => l.pendingParses(1))).map((p) => p.mailId)).toEqual([sha('a')])
    const operation = {
      kind: 'transfer_out' as const,
      amount: '3.77',
      currency: 'ARS' as const,
      date: '2026-11-14',
      time: '14:09',
      ownAccount: null,
      counterparty: { name: 'Juana Ejemplo', account: null, taxId: null },
      reference: '123456',
      reason: null,
    }
    const parsed = {
      status: 'parsed' as const,
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation,
    }
    await log((l) => l.recordParse(sha('a'), 1, parsed))
    await log((l) =>
      l.recordParse(sha('a'), 1, { ...parsed, operation: { ...operation, amount: '9.99' } }),
    )
    expect(await log((l) => l.hasParse(sha('a'), 1))).toBe(true)
    expect(await log((l) => l.hasParse(sha('a'), 2))).toBe(false)
    expect(await log((l) => l.pendingParses(1))).toEqual([])
    const pending = await log((l) => l.pendingParses(2))
    expect(pending).toMatchObject([
      {
        mailId: sha('a'),
        pathname: `u/x/mail/${sha('a')}.eml.sealed`,
        subject: 'Realizaste una transferencia',
      },
    ])
    // The stored operation is ciphertext, not JSON.
    const { rows } = await t.pg.query<{ op: Uint8Array }>('select operation as op from mail_parse')
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]?.op ?? []).includes(Buffer.from('3.77'))).toBe(false)
    expect(
      (await as((scope) => recentMail(scope))).find((r) => r.mailId === sha('a')),
    ).toMatchObject({
      parse: 'parsed',
      template: 'bbva.transfer-sent',
    })
  })

  it('refuses a malformed mail id', async () => {
    await expect(
      log((l) => l.recordMail({ ...mail('c', 'em_9'), mailId: 'XYZ' })),
    ).rejects.toThrow()
  })
})

describe('append-only enforcement', () => {
  it.each([
    "update mail_verdict set verdict = 'verified'",
    'delete from mail_verdict',
    'truncate mail_verdict cascade',
    'update inbound_mail set received_at = now()',
    'delete from mail_delivery',
    'update blob_file set bytes = 1',
    "update mail_parse set status = 'unparsed'",
    'delete from mail_parse',
  ])('blocks: %s', async (statement) => {
    await expect(t.pg.exec(statement)).rejects.toThrow(/append-only/)
  })

  it('lets warren_app append and read, and nothing else', async () => {
    const attempt = (statement: string) =>
      inUserContext(t.app, user, (tx) => tx.execute(sql.raw(statement)))
    await log((l) => l.recordMail(mail('d', 'em_4')))
    expect(await log((l) => l.hasMail(sha('d')))).toBe(true)
    await expect(attempt('drop table mail_verdict')).rejects.toThrow()
    await expect(attempt('alter table mail_verdict disable trigger all')).rejects.toThrow()
    await expect(attempt('create table x (a int)')).rejects.toThrow()
    await expect(attempt('delete from mail_verdict')).rejects.toThrow()
  })
})
