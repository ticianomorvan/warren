import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  bodies,
  count,
  doneCount,
  fakeGraph,
  gate,
  messageBody,
  movements,
  post,
  row,
  SECRET,
  seed,
  settle,
  setup,
  sign,
  sql,
  statusBody,
  until,
  useDatabase,
  VERIFY,
} from '../test-harness'
import { REPLY_NON_TEXT } from './replies'
import { validSignature } from './signature'

useDatabase()

describe('the webhook', () => {
  it('rejects a bad signature with 401 and stores nothing', async () => {
    const app = await setup()
    const body = messageBody('wamid.A')
    expect((await post(app.base, body, sign(body, 'wrong-secret'))).status).toBe(401)
    expect((await post(app.base, body, 'sha256=zz')).status).toBe(401)
    expect((await post(app.base, body, `sha256=${'0'.repeat(63)}`)).status).toBe(401)
    expect((await fetch(`${app.base}/webhook`, { method: 'POST', body })).status).toBe(401)
    await settle()
    expect(await count('wa_message')).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    app.close()
  })

  it('validSignature accepts only 64 hex digits of the right HMAC', () => {
    const raw = Buffer.from('{}')
    expect(validSignature(raw, sign('{}', SECRET), SECRET)).toBe(true)
    expect(
      validSignature(raw, sign('{}', SECRET).toUpperCase().replace('SHA256', 'sha256'), SECRET),
    ).toBe(true)
    expect(validSignature(raw, `${sign('{}', SECRET)}00`, SECRET)).toBe(false)
    expect(validSignature(raw, undefined, SECRET)).toBe(false)
  })

  it('answers an unparsable URL with 400 and keeps serving', async () => {
    const app = await setup()
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path: '//[' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
    expect((await fetch(`${app.base}/health`)).status).toBe(200)
    app.close()
  })

  it('answers an oversized body with 413', async () => {
    const app = await setup()
    const res = await post(app.base, 'x'.repeat(1_100_000))
    expect(res.status).toBe(413)
    expect(await count('wa_message')).toBe(0)
    app.close()
  })

  it('verifies the subscription only with the right token', async () => {
    const app = await setup()
    const url = (token: string) =>
      `${app.base}/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`
    const ok = await fetch(url(VERIFY))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('abc123')
    expect((await fetch(url('nope'))).status).toBe(403)
    app.close()
  })

  it('stores a text message before the 200 and answers it: one row, one turn, one reply', async () => {
    const app = await setup()
    const res = await post(app.base, messageBody('wamid.B'))
    expect(res.status).toBe(200)
    await settle()
    const r = await row('wamid.B')
    expect(r).toMatchObject({
      wa_id: '5491100000000',
      status: 'done',
      kind: 'text',
      text: 'café 3500',
      media_id: null,
      attempts: 1,
    })
    expect(r?.typing_sent_at).toBeInstanceOf(Date)
    expect(r?.send_started_at).toBeInstanceOf(Date)
    expect(r?.reply_sent_at).toBeInstanceOf(Date)
    expect(r?.meta_ts).toEqual(new Date(1760000000 * 1000))
    // The trace: the turn it made, what the agent called, where the time went.
    expect(Number(r?.turn_id)).toBeGreaterThan(0)
    expect(r?.audit).toMatchObject([{ tool: 'log_movements', status: 'accepted' }])
    expect(r?.timings).toMatchObject({
      claimed_ms: expect.any(Number),
      stamp_ms: expect.any(Number),
    })
    expect(app.calls.typing).toEqual(['wamid.B', 'wamid.B']) // on receipt, and again at the claim
    expect(app.calls.sent).toHaveLength(1)
    const [turn] = await sql`SELECT * FROM turn WHERE id = ${r?.turn_id}`
    expect(turn).toMatchObject({
      channel: 'whatsapp',
      label: 'log',
      reply: app.calls.sent[0]?.body,
    })
    const [reply] = await sql`SELECT * FROM reply`
    expect(reply).toMatchObject({ outbound_wamid: 'wamid.OUT1', wa_message_id: r?.id })
    // The sender has an account, reached by its address.
    const [address] = await sql`SELECT * FROM account_address`
    expect(address).toMatchObject({ channel: 'whatsapp', address: '5491100000000' })
    expect(String(turn?.account_id)).toBe(String(address?.account_id))
    app.close()
  })

  it('dedupes a wamid delivered twice: one row, one reply, one model call', async () => {
    const app = await setup()
    const body = messageBody('wamid.C')
    expect((await post(app.base, body)).status).toBe(200)
    await until(() => doneCount(1))
    expect((await post(app.base, body)).status).toBe(200)
    await settle()
    expect(await count('wa_message')).toBe(1)
    expect(await movements()).toHaveLength(1)
    expect(app.calls.sent).toHaveLength(1)
    expect(app.model.n).toBe(1)
    app.close()
  })

  it('processes rows a retried batch finds already stored and still pending', async () => {
    const app = await setup()
    await seed('wamid.RB') // stored by a batch that failed halfway
    expect((await post(app.base, messageBody('wamid.RB'))).status).toBe(200)
    await settle()
    expect((await row('wamid.RB'))?.status).toBe('done')
    expect(app.calls.sent).toHaveLength(1)
    app.close()
  })

  it('answers a non-text message with the short text reply, no model and no turn', async () => {
    const app = await setup()
    await post(
      app.base,
      messageBody('wamid.D', '5491100000000', { type: 'sticker', text: undefined }),
    )
    await settle()
    expect(app.calls.sent).toEqual([{ to: '5491100000000', body: REPLY_NON_TEXT }])
    expect(app.model.n).toBe(0)
    expect((await row('wamid.D'))?.turn_id).toBeNull()
    expect(await count('wa_message')).toBe(1)
    app.close()
  })

  it('a sticker then a log from the same sender are both answered with no sweep in between', async () => {
    const hold = gate()
    let first = true
    const fake = fakeGraph({
      send: async (n) => {
        // The sticker's reply is slow: the log arrives while it is still going out.
        if (first) {
          first = false
          await hold.promise
        }
        return `wamid.OUT${n}`
      },
    })
    const app = await setup({ fake })
    await post(
      app.base,
      messageBody('wamid.S1', '5491100000000', { type: 'sticker', text: undefined }),
    )
    await until(async () => (await row('wamid.S1'))?.send_started_at != null)
    await post(app.base, messageBody('wamid.S2', '5491100000000', { text: { body: 'cafe 3500' } }))
    hold.open()
    await until(async () => (await row('wamid.S2'))?.status === 'done', {
      what: 'the log after the sticker, with no sweep',
    })
    expect(app.calls.sent).toHaveLength(2)
    expect(app.calls.sent[0]?.body).toBe(REPLY_NON_TEXT)
    app.close()
  })

  it('records the message a reply answers', async () => {
    const app = await setup()
    await post(
      app.base,
      messageBody('wamid.CTX', '5491100000000', { context: { id: 'wamid.PREV' } }),
    )
    await settle()
    expect((await row('wamid.CTX'))?.context_wamid).toBe('wamid.PREV')
    app.close()
  })
})

describe('who is answered', () => {
  it('answers nobody when the allowlist is empty, and everybody with *', async () => {
    const none = await setup({ allowed: [] })
    await post(none.base, messageBody('wamid.N1'))
    await settle()
    expect((await row('wamid.N1'))?.status).toBe('ignored')
    expect(none.calls.sent).toHaveLength(0)
    expect(none.model.n).toBe(0)
    expect(await count('account')).toBe(0)
    none.close()

    const all = await setup({ allowed: ['*'] })
    await post(all.base, messageBody('wamid.N2'))
    await settle()
    expect((await row('wamid.N2'))?.status).toBe('done')
    all.close()
  })

  it('records but does not answer senders outside the allowlist: no model, no account, no reply', async () => {
    const app = await setup({ allowed: ['5491155550000'] })
    await post(app.base, messageBody('wamid.E', '5491100000000'))
    await post(app.base, messageBody('wamid.F', '5491155550000'))
    await settle()
    const rows = await sql`SELECT wamid, status FROM wa_message ORDER BY id`
    expect(rows.map((r) => [r.wamid, r.status])).toEqual([
      ['wamid.E', 'ignored'],
      ['wamid.F', 'done'],
    ])
    expect(app.calls.sent.map((s) => s.to)).toEqual(['5491155550000'])
    expect(app.model.n).toBe(1)
    const owners = await sql`SELECT address FROM account_address`
    expect(owners.map((o) => o.address)).toEqual(['5491155550000'])
    app.close()
  })
})

describe('status webhooks', () => {
  it('update the reply atomically, in any order', async () => {
    const app = await setup()
    // A status that beats the reply's own insert, then the rest out of order.
    await post(app.base, statusBody('wamid.OUT9', 'read', 1760000050))
    await post(app.base, statusBody('wamid.OUT9', 'delivered', 1760000040))
    await post(app.base, statusBody('wamid.OUT9', 'sent', 1760000030))
    await settle()
    const [r] = await sql`SELECT * FROM reply WHERE outbound_wamid = 'wamid.OUT9'`
    expect(r?.delivered_at).toEqual(new Date(1760000040 * 1000))
    expect(r?.read_at).toEqual(new Date(1760000050 * 1000))
    expect(r?.failed_at).toBeNull()
    app.close()
  })

  it('a status for a reminder send belongs to its reminder_send, not to reply', async () => {
    const app = await setup()
    await sql`INSERT INTO account DEFAULT VALUES`
    await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, status, wamid)
      SELECT id, 1, now(), 'text', 'sent', 'wamid.REM1' FROM account`
    await post(
      app.base,
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    {
                      id: 'wamid.REM1',
                      status: 'failed',
                      timestamp: '1760000050',
                      errors: [{ code: 131047, title: 'Re-engagement message' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    )
    await settle()
    expect(await count('reply')).toBe(0)
    const [send] = await sql`SELECT status, error_code FROM reminder_send`
    expect(send).toMatchObject({ status: 'retry_template', error_code: 131047 })
    app.close()
  })
})

describe('what a message leaves behind', () => {
  it('keeps no raw payload: only the identity, the text and the media id', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.RAW'))
    await settle()
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'wa_message' AND table_schema = current_schema()`
    expect(columns.map((c) => c.column_name)).not.toContain('payload')
    expect(bodies(app.calls)).toHaveLength(1)
    app.close()
  })
})
