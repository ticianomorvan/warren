import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lastTurn } from '../src/core/history'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { changedSince, importV1, mismatches, verifyV1 } from './import-v1'

/** A v1 database of synthetic rows (its structure is test/v1-schema, taken from production with no data) imported into the new schema. */
const NOW = new Date('2026-12-01T12:00:00Z')
let v1: TestDatabase
let v2: TestDatabase

beforeAll(async () => {
  v1 = await createTestDatabase({ migrations: false })
  await v1.sql.unsafe(
    readFileSync(new URL('../test/v1-schema/001_v1.sql', import.meta.url), 'utf8'),
  )
})
afterAll(async () => {
  await v1.close()
})
beforeEach(async () => {
  await v1.sql.unsafe(
    'TRUNCATE link_request, auth_oauth_access_token, auth_oauth_refresh_token, auth_oauth_consent, auth_oauth_client_resource, auth_oauth_client, auth_oauth_resource, auth_session, auth_user, reminder_send, reminder, fact, movement, reply, inbound_message, account RESTART IDENTITY CASCADE',
  )
  await seed()
  await v2?.close()
  v2 = await createTestDatabase()
})
afterAll(async () => {
  await v2?.close()
})

async function seed() {
  const s = v1.sql
  await s`INSERT INTO account (id, wa_id) VALUES (1, '5491100000001'), (2, '5491100000002'), (3, '5491100000003')`
  // The messages the rows came from: three recent, one old (outside the window), one still open at the cutover.
  const msg = (id: number, wamid: string, wa: string, status: string, daysAgo: number) =>
    s`INSERT INTO inbound_message (id, wamid, wa_id, kind, body, payload, status, received_at)
      VALUES (${id}, ${wamid}, ${wa}, 'text', 'private words', '{"x":1}', ${status}, ${new Date(NOW.getTime() - daysAgo * 86_400_000)})`
  await msg(1, 'wamid.A', '5491100000001', 'done', 2)
  await msg(2, 'wamid.B', '5491100000001', 'done', 1)
  await msg(3, 'wamid.C', '5491100000002', 'done', 1)
  await msg(4, 'wamid.OLD', '5491100000001', 'done', 90)
  await msg(5, 'wamid.OPEN', '5491100000002', 'processing', 0)
  // Account 1: a movement corrected once (v1 keeps both rows), one deleted, two plain, one in USD.
  const mv = (id: number, acc: number, amount: string, cur: string) =>
    s`INSERT INTO movement (id, account_id, inbound_message_id, position, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${id}, ${acc}, 1, ${id}, 'out', ${amount}, ${cur}, '2026-11-20', ${`thing ${id}`}, 'otros', 'high')`
  await mv(1, 1, '1000', 'ARS')
  await mv(2, 1, '1200.50', 'ARS')
  await s`UPDATE movement SET superseded_by = 2 WHERE id = 1`
  await s`UPDATE movement SET payment = 'visa' WHERE id = 2`
  await mv(3, 1, '300', 'ARS')
  await s`UPDATE movement SET deleted_at = ${NOW}, deleted_by = 2 WHERE id = 3`
  await mv(4, 1, '45', 'USD')
  await mv(5, 1, '10.25', 'ARS')
  await mv(6, 2, '999', 'ARS')
  await s`INSERT INTO fact (id, account_id, kind, key, value, inbound_message_id) VALUES
    (1, 1, 'alias', 'chino', 'supermercado', 1), (2, 1, 'note', 'viejo', 'replaced', 1), (3, 1, 'note', 'nuevo', 'x', 2)`
  await s`UPDATE fact SET superseded_by = 3 WHERE id = 2`
  await s`INSERT INTO reminder (id, account_id, what, schedule, next_due_at, sent_count, inbound_message_id) VALUES
    (1, 1, 'pagar el alquiler', '{"kind":"monthly","day":5,"time":"09:00"}', ${new Date('2026-12-05T12:00:00Z')}, 2, 1),
    (2, 1, 'cancelado', '{"kind":"once"}', NULL, 0, 1),
    (3, 2, 'una vez', '{"kind":"once"}', NULL, 1, 3)`
  await s`UPDATE reminder SET cancelled_at = ${NOW}, cancelled_by = 2 WHERE id = 2`
  await s`INSERT INTO reminder_send (reminder_id, due_at, kind, status, wamid) VALUES
    (1, ${new Date('2026-11-05T12:00:00Z')}, 'text', 'sent', 'wamid.R1'), (3, ${new Date('2026-11-30T12:00:00Z')}, 'text', 'sent', 'wamid.R3'),
    (2, ${new Date('2026-11-01T12:00:00Z')}, 'text', 'sent', 'wamid.R2')`
  // The auth side: a user for account 1, a client, a consent.
  await s`INSERT INTO auth_user (id, name, email, "emailVerified", warren_account_id) VALUES ('11111111-1111-4111-8111-111111111111', 'u', 'a1@users.invalid', true, 1)`
  await s`INSERT INTO auth_oauth_client (id, "clientId", "redirectUris") VALUES ('22222222-2222-4222-8222-222222222222', 'https://claude.ai/oauth/x.json', ${s.json(['https://claude.ai/cb'])})`
}

const live = (t: string) =>
  v2.sql.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE ended_at IS NULL`)

describe('import-v1', () => {
  it('brings the live rows across and nothing that was history', async () => {
    const summary = await importV1(v1.sql, v2.sql, { now: NOW })
    const { snapshot, ...counts } = summary
    expect(counts).toEqual({ accounts: 3, movements: 4, facts: 2, reminders: 2, waMessages: 4 })
    expect(snapshot.movement).toMatch(/^6\|6\|/)
    expect((await live('movement'))[0]?.n).toBe(4)
    expect((await v2.sql`SELECT count(*)::int AS n FROM movement`)[0]?.n).toBe(4)
  })

  it('verifies: every account, live counts and sums per currency, facts, reminders with next_due_at, auth', async () => {
    await importV1(v1.sql, v2.sql, { now: NOW })
    const checks = await verifyV1(v1.sql, v2.sql, { now: NOW })
    expect(mismatches(checks)).toEqual([])
    const sums =
      await v2.sql`SELECT currency, count(*)::int AS n, sum(amount)::text AS total FROM movement WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`
    expect(sums.map((r) => [r.currency, r.n, r.total])).toEqual([
      ['ARS', 3, '2209.75'],
      ['USD', 1, '45'],
    ])
    const [r] = await v2.sql`SELECT next_due_at FROM reminder WHERE what = 'pagar el alquiler'`
    expect(r?.next_due_at).toEqual(new Date('2026-12-05T12:00:00Z'))
    // The occurrence that was sent stays sent, and the cancelled reminder's send did not come.
    expect((await v2.sql`SELECT count(*)::int AS n FROM reminder_send`)[0]?.n).toBe(2)
    expect(
      (await v2.sql`SELECT count(*)::int AS n FROM auth_user WHERE warren_account_id = 1`)[0]?.n,
    ).toBe(1)
    expect((await v2.sql`SELECT count(*)::int AS n FROM auth_oauth_client`)[0]?.n).toBe(1)
  })

  it('keeps recent wamids for dedupe (no text), and marks the one still open as failed', async () => {
    await importV1(v1.sql, v2.sql, { now: NOW })
    const rows = await v2.sql`SELECT wamid, status, text, media_id FROM wa_message ORDER BY wamid`
    expect(rows.map((r) => r.wamid)).toEqual(['wamid.A', 'wamid.B', 'wamid.C', 'wamid.OPEN'])
    expect(rows.every((r) => r.text === null && r.media_id === null)).toBe(true)
    expect(rows.find((r) => r.wamid === 'wamid.OPEN')?.status).toBe('failed')
  })

  it("leaves nothing to undo: the imported batch is not the account's last turn", async () => {
    await importV1(v1.sql, v2.sql, { now: NOW })
    for (const id of [1, 2]) expect(await lastTurn(v2.sql, id, NOW)).toBeNull()
    const [t] = await v2.sql`SELECT count(*)::int AS n FROM turn WHERE account_id = 1`
    expect(t?.n).toBe(2)
  })

  it("carries the sequences on: a sign-in opened after the import gets a fresh id, and the old database's ids stay", async () => {
    await v1.sql`INSERT INTO link_request (id, code, secret_hash, client_name, ip_hash, expires_at)
                 VALUES (7, 'ABC234', 'h', 'c', 'i', now() + interval '1 hour')`
    await importV1(v1.sql, v2.sql, { now: NOW })
    const [next] =
      await v2.sql`SELECT nextval(pg_get_serial_sequence('link_request', 'id'))::int AS id`
    expect(next?.id).toBe(8)
    const [moved] = await v2.sql`SELECT nextval(pg_get_serial_sequence('account', 'id'))::int AS id`
    expect(moved?.id).toBe(4)
  })

  it('leaves the old database as it was, and the snapshot it takes matches a fresh read', async () => {
    const before = await v1.sql`SELECT count(*)::int AS n FROM movement`
    await importV1(v1.sql, v2.sql, { now: NOW })
    expect(await v1.sql`SELECT count(*)::int AS n FROM movement`).toEqual(before)
    // `snapshot` is what the cutover re-checks.
    const { snapshot } = await importV1(v1.sql, (await createTestDatabase()).sql, { now: NOW })
    expect(await changedSince(v1.sql, snapshot)).toEqual([])
  })

  it('notices a write to the old database after the import read: a new row, or a row that changed', async () => {
    const { snapshot } = await importV1(v1.sql, v2.sql, { now: NOW })
    await v1.sql`INSERT INTO inbound_message (id, wamid, wa_id, kind, body, payload, status, received_at)
                 VALUES (99, 'wamid.LATE', '5491100000001', 'text', 'x', '{}', 'done', ${NOW})`
    expect(await changedSince(v1.sql, snapshot)).toEqual(['inbound_message'])
    await v1.sql`DELETE FROM inbound_message WHERE id = 99`
    // A row that is only updated keeps its count and highest id: its newer version shows.
    await v1.sql`UPDATE fact SET value = 'changed' WHERE id = 3`
    expect(await changedSince(v1.sql, snapshot)).toContain('fact')
  })

  it('refuses to import twice', async () => {
    await importV1(v1.sql, v2.sql, { now: NOW })
    await expect(importV1(v1.sql, v2.sql, { now: NOW })).rejects.toThrow(/already has accounts/)
  })

  describe('verify catches a tampered copy', () => {
    const tampered = async (change: () => Promise<unknown>) => {
      await importV1(v1.sql, v2.sql, { now: NOW })
      expect(mismatches(await verifyV1(v1.sql, v2.sql, { now: NOW }))).toEqual([])
      await change()
      return mismatches(await verifyV1(v1.sql, v2.sql, { now: NOW })).map((c) => c.name)
    }
    it('a changed amount', async () => {
      // The append-only trigger forbids it on a live schema; a bad import would be caught the same, so bypass it for the test.
      const names = await tampered(async () => {
        await v2.sql`ALTER TABLE movement DISABLE TRIGGER movement_append_only`
        await v2.sql`UPDATE movement SET amount = amount + 1 WHERE description = 'thing 2'`
      })
      expect(names).toEqual([
        'live movements: count and sum per account and currency',
        'live movements: a fingerprint of what each one says, per account',
      ])
    })
    const swap = async (sqlText: string) =>
      tampered(async () => {
        await v2.sql`ALTER TABLE movement DISABLE TRIGGER movement_append_only`
        await v2.sql.unsafe(sqlText)
      })
    const FINGERPRINT = 'live movements: a fingerprint of what each one says, per account'
    it('a swapped direction', async () => {
      expect(
        await swap(`UPDATE movement SET direction = 'in' WHERE description = 'thing 2'`),
      ).toEqual([FINGERPRINT])
    })
    it('a shifted date', async () => {
      expect(
        await swap(
          `UPDATE movement SET occurred_on = occurred_on + 1 WHERE description = 'thing 2'`,
        ),
      ).toEqual([FINGERPRINT])
    })
    it('a dropped payment', async () => {
      expect(
        await swap(`UPDATE movement SET payment = NULL WHERE description = 'thing 2'`),
      ).toEqual([FINGERPRINT])
    })
    it('a changed reminder text or schedule', async () => {
      const names = await tampered(async () => {
        await v2.sql`ALTER TABLE reminder DISABLE TRIGGER reminder_append_only`
        await v2.sql`UPDATE reminder SET schedule = '{"kind":"monthly","day":6,"time":"09:00"}'::jsonb WHERE what = 'pagar el alquiler'`
      })
      expect(names).toEqual([
        'live reminders: a fingerprint of what, schedule and next due time, per account',
      ])
    })
    it('a missing reminder due time', async () => {
      const names = await tampered(async () => {
        await v2.sql`ALTER TABLE reminder DISABLE TRIGGER reminder_append_only`
        await v2.sql`UPDATE reminder SET next_due_at = NULL WHERE what = 'pagar el alquiler'`
      })
      expect(names[0]).toMatch(/^live reminders/)
    })
    it('a missing auth client', async () => {
      const names = await tampered(async () => {
        await v2.sql`DELETE FROM auth_oauth_client`
      })
      expect(names).toEqual(['auth_oauth_client: count'])
    })
  })
})
