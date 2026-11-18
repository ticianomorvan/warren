import { createHash } from 'node:crypto'
import { newDataKey, open, SealError, seal } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../src/client'
import { createLedger } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox } from '../src/outbox'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string

// Invented; the strings below must not appear in the clear anywhere in the sealed columns.
const NAME = 'Juana Ejemplo'
const SECRET_SUBJECT = 'Realizaste una transferencia'
const op = {
  kind: 'transfer_out' as const,
  amount: '1500.00',
  currency: 'ARS' as const,
  date: '2026-11-14',
  time: '14:09',
  ownAccount: null,
  counterparty: { name: NAME, account: '0170099220000012345670', taxId: '20123456786' },
  reference: '1017000001',
  reason: 'VARIOS',
}

async function feed(user: string, raw: string) {
  return asUser(t.app, user, async (scope) => {
    const mailId = scope.mailId(Buffer.from(raw))
    const log = createMailLog(scope)
    await log.recordMail({
      mailId,
      pathname: `u/${user}/mail/${mailId}.eml.sealed`,
      bytes: raw.length,
      provider: 'resend',
      providerId: `em_${mailId.slice(0, 8)}`,
      receivedAt: new Date('2026-11-14T13:00:40Z'),
    })
    await log.recordVerdict(
      mailId,
      {
        verdict: 'verified',
        senderId: 'bbva-transfers',
        fromAddress: 'avisos@bbva.com.ar',
        signingDomain: 'bbva.com.ar',
        selector: 's1',
        keyRecord: 'v=DKIM1',
        signedHeaders: ['from', 'to', 'date', 'subject'],
        subject: SECRET_SUBJECT,
        signedDate: new Date('2026-11-14T13:00:00Z'),
      },
      1,
    )
    await log.recordParse(mailId, 1, {
      status: 'parsed',
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation: op,
    })
    await createLedger(scope).recordMailOperation({
      mailId,
      templateId: 'bbva.transfer-sent',
      operation: op,
    })
    await createOutbox(scope).drain(async (n) =>
      n.history.length > 0
        ? null
        : {
            mode: 'text',
            body: `Transferencia enviada a ${NAME}`,
            outcome: 'sent',
            wamid: `wamid.${user.slice(0, 8)}.${n.noticeId}`,
          },
    )
    return mailId
  })
}

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
})

const bytesOf = async (sqlText: string) =>
  (await t.pg.query<Record<string, Uint8Array>>(sqlText)).rows.map((r) =>
    Buffer.from(Object.values(r)[0] ?? []),
  )

describe('sealed columns', () => {
  it('hold ciphertext: no name, amount, account number or subject shows through', async () => {
    await feed(a, 'raw mail a')
    const columns = [
      'select payload from event',
      'select operation from mail_parse',
      'select operation from movement_source',
      'select subject from mail_verdict',
      'select body from notice_attempt',
    ]
    for (const q of columns) {
      const [value] = await bytesOf(q)
      expect(value, q).toBeDefined()
      expect(value?.[0], `${q} has the seal version first`).toBe(1)
      for (const clear of [
        NAME,
        '1500.00',
        '0170099220000012345670',
        SECRET_SUBJECT,
        'Transferencia',
      ]) {
        expect(value?.includes(Buffer.from(clear)), `${q} leaks ${clear}`).toBe(false)
      }
    }
  })

  it('open for their own user with the row they belong to, and for nobody else', async () => {
    const { rows } = await t.pg.query<{ id: string; payload: Uint8Array }>(
      'select id, payload from event where user_id = $1',
      [a],
    )
    const event = rows[0]
    if (!event) throw new Error('no event')
    await asUser(t.app, a, async (scope) => {
      expect(
        scope.json.open<{ source: string }>(event.payload, `event:${event.id}:payload`).source,
      ).toBe('mail')
      // The same bytes under another row's name do not open: the row is part of the seal.
      expect(() => scope.open(event.payload, 'event:another-row:payload')).toThrow(SealError)
    })
    await feed(b, 'raw mail b')
    await asUser(t.app, b, async (scope) => {
      expect(() => scope.open(event.payload, `event:${event.id}:payload`)).toThrow(SealError)
    })
  })

  it('names a mail by a keyed hash: not the SHA-256 of its bytes, and different for each user', async () => {
    const same = 'the very same bytes'
    const idA = await asUser(t.app, a, async (scope) => scope.mailId(Buffer.from(same)))
    const idB = await asUser(t.app, b, async (scope) => scope.mailId(Buffer.from(same)))
    expect(idA).not.toBe(idB)
    expect(idA).not.toBe(createHash('sha256').update(same).digest('hex'))
  })

  it('hashes the chain over the sealed bytes, as stored', async () => {
    const { rows } = await t.pg.query<{ ok: boolean }>(
      'select bool_and(payload_sha256 = sha256(payload)) ok from event',
    )
    expect(rows[0]?.ok).toBe(true)
  })

  it('lets two users store the same mail without either learning of the other', async () => {
    // Same raw bytes, two users: different ids, so neither insert can hit the other's key.
    const raw = 'forwarded to both'
    const [x, y] = [await feed(a, raw).catch((e) => e), await feed(b, raw).catch((e) => e)]
    expect(x).not.toBeInstanceOf(Error)
    expect(y).not.toBeInstanceOf(Error)
    expect(x).not.toBe(y)
  })

  it('rejects a key of the wrong size and a sealed value that is not one', () => {
    expect(() => seal(newDataKey().subarray(0, 8), Buffer.from('x'), 'a')).toThrow(SealError)
    expect(() => open(newDataKey(), Buffer.from('plain text, not sealed at all'), 'a')).toThrow(
      SealError,
    )
  })
})
