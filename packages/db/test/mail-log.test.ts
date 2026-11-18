import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { MailVerdict, NewMail } from '@warren/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/client'
import { createMailLog, recentMail } from '../src/mail-log'
import * as schema from '../src/schema'

const pg = new PGlite()
const db = drizzle(pg, { schema }) as unknown as Db
const log = createMailLog(db)

const sha = (c: string) => c.repeat(64)
const mail = (c: string, providerId: string): NewMail => ({
  sha256: sha(c),
  pathname: `raw/mail/${sha(c)}.eml`,
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
  await migrate(drizzle(pg), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  })
})

describe('mail log', () => {
  it('records a mail once, however many times it is delivered', async () => {
    await log.recordMail(mail('a', 'em_1'))
    await log.recordMail(mail('a', 'em_1'))
    await log.recordMail(mail('a', 'em_2'))
    expect(await log.findDelivery('resend', 'em_1')).toBe(sha('a'))
    expect(await log.findDelivery('resend', 'em_2')).toBe(sha('a'))
    expect(await log.findDelivery('resend', 'nope')).toBeNull()
    const { rows } = await pg.query<{ n: number }>('select count(*)::int n from inbound_mail')
    expect(rows[0]?.n).toBe(1)
  })

  it('treats retry as not final, verified and rejected as final', async () => {
    await log.recordVerdict(
      sha('a'),
      { verdict: 'retry', reason: 'dns-temperror', fromAddress: null },
      1,
    )
    expect(await log.finalVerdict(sha('a'))).toBeNull()
    await log.recordVerdict(sha('a'), verified, 1)
    expect(await log.finalVerdict(sha('a'))).toEqual({
      verdict: 'verified',
      senderId: 'bbva-transfers',
      subject: 'Realizaste una transferencia',
      signedDate: new Date('2026-11-14T13:00:00Z'),
    })

    await log.recordMail(mail('b', 'em_3'))
    await log.recordVerdict(
      sha('b'),
      {
        verdict: 'rejected',
        reason: 'date-skew',
        fromAddress: 'avisos@bbva.com.ar',
        detail: '900 min',
      },
      1,
    )
    expect(await log.finalVerdict(sha('b'))).toEqual({ verdict: 'rejected' })
  })

  it('lists each mail with its latest status', async () => {
    const rows = await recentMail(db)
    const a = rows.find((r) => r.sha256 === sha('a'))
    const b = rows.find((r) => r.sha256 === sha('b'))
    expect(a).toMatchObject({ verdict: 'verified', senderId: 'bbva-transfers', attempts: 2 })
    expect(b).toMatchObject({
      verdict: 'rejected',
      reason: 'date-skew',
      detail: '900 min',
      attempts: 1,
    })
  })

  it('records one parse per mail and template set, and lists what is pending', async () => {
    expect((await log.pendingParses(1)).map((p) => p.sha256)).toEqual([sha('a')])
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
    await log.recordParse(sha('a'), 1, parsed)
    await log.recordParse(sha('a'), 1, { ...parsed, operation: { ...operation, amount: '9.99' } })
    expect(await log.hasParse(sha('a'), 1)).toBe(true)
    expect(await log.hasParse(sha('a'), 2)).toBe(false)
    expect(await log.pendingParses(1)).toEqual([])
    expect((await log.pendingParses(2)).map((p) => p.pathname)).toEqual([
      `raw/mail/${sha('a')}.eml`,
    ])
    const { rows } = await pg.query<{ amount: string }>(
      "select operation->>'amount' amount from mail_parse",
    )
    expect(rows).toEqual([{ amount: '3.77' }])
    expect((await recentMail(db)).find((r) => r.sha256 === sha('a'))).toMatchObject({
      parse: 'parsed',
      template: 'bbva.transfer-sent',
    })
  })

  it('refuses a malformed hash', async () => {
    await expect(log.recordMail({ ...mail('c', 'em_9'), sha256: 'XYZ' })).rejects.toThrow()
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
    await expect(pg.exec(statement)).rejects.toThrow(/append-only/)
  })

  it('lets warren_app append and read, and nothing else', async () => {
    await pg.exec('set role warren_app')
    try {
      await log.recordMail(mail('d', 'em_4'))
      expect(await log.findDelivery('resend', 'em_4')).toBe(sha('d'))
      await expect(pg.exec('drop table mail_verdict')).rejects.toThrow(/must be owner/)
      await expect(pg.exec('alter table mail_verdict disable trigger all')).rejects.toThrow(
        /must be owner/,
      )
      await expect(pg.exec('create table x (a int)')).rejects.toThrow(/permission denied/)
    } finally {
      await pg.exec('reset role')
    }
  })
})
