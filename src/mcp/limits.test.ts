import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { cafe } from '../../test/core'
import { type App, EMAIL_A, EMAIL_B, mint, withClaude } from '../auth-test-kit'
import { MAX_LIVE_MOVEMENTS } from '../domain/movements'
import { call, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'

/** Open sign-up needs limits: one account cannot fill the database or hammer the door, and the refusals carry a typed code. */
useDatabase({ max: 12 })

let app: App
afterEach(() => app.close())

const movement = (o: Record<string, unknown> = {}) => ({ ...cafe({ date: TODAY }), ...o })

describe('calls per minute at the door', () => {
  it('refuses past the limit with 429 and the typed code rate_limited, per account, and opens again with the next minute', async () => {
    let at = 1_760_000_000_000
    ;({ app } = await withClaude({ callsPerMinute: 5, clock: () => new Date(at) }))
    const a = await mint(app, EMAIL_A)
    const b = await mint(app, EMAIL_B)
    for (let i = 0; i < 5; i++)
      expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(200)
    const over = await rpc(app, a.access_token, 'tools/list')
    expect(over.status).toBe(429)
    expect(over.body).toMatchObject({ code: 'rate_limited', error: { message: 'rate_limited' } })
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(over.headers.get('www-authenticate')).toBeNull() // not an auth failure: the client must not sign in again
    // Another person is not counted against this one.
    expect((await rpc(app, b.access_token, 'tools/list')).status).toBe(200)
    // A fixed minute: the next one starts clean.
    at += 61_000
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(200)
  })

  it('counts only requests the door admitted: a bad token spends nobody’s allowance', async () => {
    ;({ app } = await withClaude({ callsPerMinute: 2 }))
    const a = await mint(app, EMAIL_A)
    for (let i = 0; i < 6; i++) expect((await rpc(app, 'garbage', 'tools/list')).status).toBe(401)
    expect((await rpc(app, a.access_token, 'tools/list')).status).toBe(200)
  })
})

describe('the cap on live movements', () => {
  it('refuses a log that would go past it with the typed code movement_limit, writes nothing, and lets deleting make room', async () => {
    ;({ app } = await withClaude())
    const a = await mint(app, EMAIL_A)
    const c = a
    const [account] = await sql`SELECT warren_account_id AS id FROM auth_user LIMIT 1`
    const id = account?.id as number
    // Fills the account to 2 below the cap in one statement: logging 100k rows through the tool would only slow the test.
    await sql`INSERT INTO turn (id, account_id, client) VALUES (1000, ${id}, 'test')`
    await sql`
      INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
      SELECT ${id}, 1000, 'out', 1, 'ARS', ${TODAY}::date, 'x', 'otros', 'high' FROM generate_series(1, ${MAX_LIVE_MOVEMENTS - 2})`
    const turnsBefore = (await sql`SELECT count(*)::int AS n FROM turn`)[0]?.n
    const message = refused(
      await call(app, a.access_token, 'warren_log_movements', {
        movements: [movement(), movement(), movement()],
      }),
      'movement_limit',
    )
    expect(message).toContain(String(MAX_LIVE_MOVEMENTS))
    expect((await sql`SELECT count(*)::int AS n FROM turn`)[0]?.n).toBe(turnsBefore)
    expect((await sql`SELECT count(*)::int AS n FROM movement`)[0]?.n).toBe(MAX_LIVE_MOVEMENTS - 2)
    // Exactly to the cap is allowed.
    ok(
      await call(app, a.access_token, 'warren_log_movements', {
        movements: [movement(), movement()],
      }),
      'log_movements',
    )
    refused(
      await call(app, a.access_token, 'warren_log_movements', { movements: [movement()] }),
      'movement_limit',
    )
    // A retry of the write that reached the cap gets its first answer, not movement_limit.
    const requestId = randomUUID()
    ok(await call(app, c.access_token, 'warren_delete_movement', { id: 1 }), 'delete_movement')
    const first = ok(
      await call(app, c.access_token, 'warren_log_movements', {
        movements: [movement()],
        request_id: requestId,
      }),
      'log_movements',
    )
    const retry = ok(
      await call(app, c.access_token, 'warren_log_movements', {
        movements: [movement()],
        request_id: requestId,
      }),
      'log_movements',
    )
    expect(retry).toEqual({ ...first, replayed: true })
    // The cap is the account's own: another person is not held by it.
    const b = await mint(app, EMAIL_B)
    ok(
      await call(app, b.access_token, 'warren_log_movements', { movements: [movement()] }),
      'log_movements',
    )
  })
})
