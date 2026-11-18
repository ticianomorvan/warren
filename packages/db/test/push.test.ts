import { type BankOperation, flushNotices, memoryPushSender, sendTestPush } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { allowAction } from '../src/auth'
import { asUser, type Scope } from '../src/client'
import { createLedger, listMovements, seedAccounts } from '../src/ledger'
import { createMailLog } from '../src/mail-log'
import { createOutbox, recentNotices } from '../src/outbox'
import { createPushStore, MAX_SUBSCRIPTIONS } from '../src/push'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string
let other: string
const as = <T>(fn: (scope: Scope) => Promise<T>) => asUser(t.app, user, fn)
const withOutbox = <T>(fn: (o: ReturnType<typeof createOutbox>) => Promise<T>) =>
  as((scope) => fn(createOutbox(scope)))

// Invented values with valid shapes; the endpoints are never called.
const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}
const phone = { endpoint: 'https://fcm.example.invalid/send/phone-secret-token', ...KEYS }
const laptop = { endpoint: 'https://push.example.invalid/laptop-secret-token', ...KEYS }

const purchase = (n: number): BankOperation => ({
  kind: 'card_purchase',
  cardLastFour: '1234',
  merchant: `Comercio ${n}`,
  amount: `${100 + n}.00`,
  currency: 'ARS',
  date: `2026-11-${String(10 + n).padStart(2, '0')}`,
  cardType: 'credit',
})

const record = (n: number) =>
  as(async (scope) => {
    const mailId = sha(String(n))
    await createMailLog(scope).recordMail({
      mailId,
      pathname: `u/x/mail/${mailId}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${n}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    return createLedger(scope).recordMailOperation(
      { mailId, templateId: 'bbva.card-purchase', operation: purchase(n) },
      { notify: true },
    )
  })

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('push')
  other = await t.newUser('other')
  await asUser(t.owner, user, (scope) =>
    seedAccounts(scope, [
      {
        id: 'liability:card:visa',
        kind: 'liability',
        name: 'Visa',
        currency: 'ARS',
        institution: 'Bank',
        identifiers: [{ scheme: 'card-last-four', value: '1234' }],
      },
    ]),
  )
})

describe('push subscriptions', () => {
  it('adds one, once per browser, and opens it again', async () => {
    expect(await as((s) => createPushStore(s).add(phone))).toBe('added')
    expect(await as((s) => createPushStore(s).add(phone))).toBe('exists')
    expect(await as((s) => createPushStore(s).count())).toBe(1)
    expect(await as((s) => createPushStore(s).has(phone.endpoint))).toBe(true)
    expect(await as((s) => createPushStore(s).has(laptop.endpoint))).toBe(false)
    const [stored] = await as((s) => createPushStore(s).list())
    expect(stored?.subscription).toEqual(phone)
  })

  it('keeps the endpoint and keys sealed, and finds a browser without opening it', async () => {
    const { rows } = await t.pg.query<Record<string, unknown>>('select * from push_subscription')
    const raw = JSON.stringify(rows)
    expect(raw).not.toContain('phone-secret-token')
    expect(raw).not.toContain(KEYS.auth)
    const row = rows[0] as { endpoint_key: string; endpoint: Uint8Array }
    expect(row.endpoint_key).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(row.endpoint).includes(Buffer.from('phone-secret-token'))).toBe(false)
  })

  it('does not open on another row or for another user', async () => {
    await asUser(t.app, other, (s) => createPushStore(s).add(phone))
    // The same endpoint is a different key for each user: nothing can be correlated.
    const { rows } = await t.pg.query<{ endpoint_key: string }>(
      'select endpoint_key from push_subscription',
    )
    expect(new Set(rows.map((r) => r.endpoint_key)).size).toBe(rows.length)
    expect(await asUser(t.app, other, (s) => createPushStore(s).count())).toBe(1)
    // A sealed value copied onto another user's row does not open there.
    await t.pg.query(
      `update push_subscription set endpoint = (select endpoint from push_subscription where user_id = $1)
       where user_id = $2`,
      [user, other],
    )
    await expect(asUser(t.app, other, (s) => createPushStore(s).list())).rejects.toThrow()
    await t.pg.query('delete from push_subscription where user_id = $1', [other])
  })

  it('may be deleted by its owner and by nobody else, and never updated', async () => {
    await as((s) => createPushStore(s).add(laptop))
    expect(await asUser(t.app, other, (s) => createPushStore(s).remove(laptop.endpoint))).toBe(
      false,
    )
    const update = await as((s) =>
      s.tx.execute(sql`update push_subscription set endpoint_key = 'x'`),
    ).then(
      () => 'accepted',
      (e: { cause?: unknown }) => String(e.cause),
    )
    expect(update).toMatch(/permission denied/)
    expect(await as((s) => createPushStore(s).remove(laptop.endpoint))).toBe(true)
    expect(await as((s) => createPushStore(s).remove(laptop.endpoint))).toBe(false)
  })
})

describe('subscription limits', () => {
  it('replaces a browser stored with other keys, and refuses the eleventh', async () => {
    const rekeyed = { ...phone, auth: 'AAAAAAAAAAAAAAAAAAAAAA' }
    expect(await as((s) => createPushStore(s).add(rekeyed))).toBe('added')
    expect(await as((s) => createPushStore(s).count())).toBe(1)
    const [stored] = await as((s) => createPushStore(s).list())
    expect(stored?.subscription.auth).toBe(rekeyed.auth)
    for (let i = 1; i < MAX_SUBSCRIPTIONS; i++) {
      const more = { ...phone, endpoint: `https://fcm.example.invalid/${i}` }
      expect(await as((s) => createPushStore(s).add(more))).toBe('added')
    }
    const eleventh = { ...phone, endpoint: 'https://fcm.example.invalid/eleventh' }
    expect(await as((s) => createPushStore(s).add(eleventh))).toBe('limit')
    // The browser already stored is not "another": it is replaced, not refused.
    expect(await as((s) => createPushStore(s).add(phone))).toBe('added')
    await t.pg.query('delete from push_subscription where user_id = $1', [user])
    await as((s) => createPushStore(s).add(phone))
  })
})

describe('notices over push, through the database', () => {
  it('delivers each notice once, records the attempt sealed, and shows it in the history', async () => {
    await as((s) => createPushStore(s).add(laptop))
    await record(1)
    const push = memoryPushSender()
    const made = await flushNotices(withOutbox, { push })
    expect(made).toHaveLength(2)
    expect(push.sent.map((s) => s.payload.title)).toEqual([
      'Compra con tarjeta …1234',
      'Compra con tarjeta …1234',
    ])
    expect(push.sent[0]?.payload.url).toBe('/movements')
    expect(await flushNotices(withOutbox, { push })).toHaveLength(0)
    const { rows } = await t.pg.query<{ mode: string; outcome: string; body: Uint8Array }>(
      "select mode, outcome, body from notice_attempt where mode = 'push'",
    )
    expect(rows.map((r) => `${r.mode}:${r.outcome}`)).toEqual(['push:sent', 'push:sent'])
    expect(Buffer.from(rows[0]?.body ?? []).includes(Buffer.from('Comercio'))).toBe(false)
    expect((await as((s) => recentNotices(s)))[0]).toMatchObject({
      lastMode: 'push',
      lastOutcome: 'sent',
    })
  })

  it('records a temporary failure, retries it, and gives up for good on a final one', async () => {
    await record(2)
    let answer: 'fail' | 'ok' = 'fail'
    const push = memoryPushSender((s) =>
      s.endpoint === laptop.endpoint
        ? answer === 'fail'
          ? { outcome: 'failed', retryable: true, status: 503 }
          : { outcome: 'sent' }
        : { outcome: 'failed', retryable: false, status: 400 },
    )
    await flushNotices(withOutbox, { push })
    await flushNotices(withOutbox, { push })
    expect(push.sent.filter((s) => s.subscription.endpoint === phone.endpoint)).toHaveLength(1)
    expect(push.sent.filter((s) => s.subscription.endpoint === laptop.endpoint)).toHaveLength(2)
    answer = 'ok'
    await flushNotices(withOutbox, { push })
    const { rows } = await t.pg.query<{
      outcome: string
      retryable: boolean | null
      status_code: number | null
    }>(
      `select outcome, retryable, status_code from notice_attempt
       where mode = 'push' and notice_id = 2 order by id`,
    )
    expect(rows.map((r) => `${r.outcome}/${r.retryable}/${r.status_code}`)).toEqual([
      'failed/false/400',
      'failed/true/503',
      'failed/true/503',
      'sent/null/null',
    ])
  })

  it('deletes a subscription the push service calls gone, keeping the attempt', async () => {
    await record(3)
    const push = memoryPushSender((s) =>
      s.endpoint === phone.endpoint ? { outcome: 'gone', status: 410 } : { outcome: 'sent' },
    )
    await flushNotices(withOutbox, { push })
    expect(await as((s) => createPushStore(s).has(phone.endpoint))).toBe(false)
    expect(await as((s) => createPushStore(s).has(laptop.endpoint))).toBe(true)
    const { rows } = await t.pg.query<{ status_code: number; retryable: boolean }>(
      "select status_code, retryable from notice_attempt where mode = 'push' and status_code = 410",
    )
    expect(rows).toEqual([{ status_code: 410, retryable: false }])
  })

  it('leaves a notice owed with no subscription, and pushes it once there is one', async () => {
    await as((s) => createPushStore(s).remove(laptop.endpoint))
    await record(4)
    const push = memoryPushSender()
    expect(await flushNotices(withOutbox, { push })).toHaveLength(0)
    await as((s) => createPushStore(s).add(phone))
    const made = await flushNotices(withOutbox, { push })
    expect(made).toHaveLength(1)
    expect(push.sent[0]?.payload.body).toContain('Comercio 4')
  })

  it('sends a test push to every subscription', async () => {
    await as((s) => createPushStore(s).add(laptop))
    const push = memoryPushSender()
    const payload = { title: 'Warren', body: 'Prueba', tag: 'test', url: '/movements' }
    expect(await sendTestPush(withOutbox, push, payload)).toEqual({ sent: 2, gone: 0, failed: 0 })
  })

  it('refuses a push attempt that does not name its subscription, or a failed one that is sent', async () => {
    const bad = (sql: string) => t.pg.query(sql)
    const base = `insert into notice_attempt (user_id, notice_id, body`
    await expect(
      bad(`${base}, mode, outcome) values ('${user}', 1, '\\x00', 'push', 'sent')`),
    ).rejects.toThrow(/notice_attempt_/)
    await expect(
      bad(
        `${base}, mode, outcome, subscription_id) values ('${user}', 1, '\\x00', 'text', 'sent', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/notice_attempt_/)
    await expect(
      bad(
        `${base}, mode, outcome, subscription_id, retryable) values ('${user}', 1, '\\x00', 'push', 'sent', gen_random_uuid(), true)`,
      ),
    ).rejects.toThrow(/notice_attempt_/)
  })
})

describe('listMovements', () => {
  it('lists newest first with account names, and pages by cursor without gaps or repeats', async () => {
    for (let n = 5; n <= 9; n++) await record(n)
    const first = await as((s) => listMovements(s, null, 4))
    expect(first.items).toHaveLength(4)
    expect(first.items[0]).toMatchObject({
      date: '2026-11-19',
      type: 'card_purchase',
      direction: 'out',
      amount: '109.00000000',
      counterpartyName: 'Comercio 9',
      accountName: 'Visa',
      cardLastFour: '1234',
    })
    expect(first.next).toMatch(/^2026-11-\d\d_\d+$/)
    const second = await as((s) => listMovements(s, first.next, 4))
    const third = await as((s) => listMovements(s, second.next, 4))
    const ids = [...first.items, ...second.items, ...third.items].map((m) => m.id)
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
    const dates = [...first.items, ...second.items, ...third.items].map((m) => m.date)
    expect(dates).toEqual([...dates].sort().reverse())
    expect(third.next).toBeNull()
  })

  it('takes a malformed cursor as the first page, and shows another user nothing', async () => {
    const page = await as((s) => listMovements(s, "x'; drop table movement; --", 3))
    expect(page.items).toHaveLength(3)
    expect((await asUser(t.app, other, (s) => listMovements(s, null))).items).toEqual([])
  })
})

describe('allowAction', () => {
  it('allows `max` calls per window, per key, and starts a new window after it', async () => {
    const hit = (key: string, now: number) => allowAction(t.auth, key, 3, 600_000, now)
    const t0 = 1_800_000_000_000
    expect(await hit('push-test:a', t0)).toBe(true)
    expect(await hit('push-test:a', t0 + 1)).toBe(true)
    expect(await hit('push-test:a', t0 + 2)).toBe(true)
    expect(await hit('push-test:a', t0 + 3)).toBe(false)
    expect(await hit('push-test:a', t0 + 599_999)).toBe(false)
    expect(await hit('push-test:b', t0 + 4)).toBe(true)
    expect(await hit('push-test:a', t0 + 600_001)).toBe(true)
  })
})
