/**
 * `pnpm probe staging|production`: the product, proven from outside, with no person in the loop.
 *
 * staging: signed WhatsApp webhooks (log, correct, undo, a question then its answer, a voice note, a photo, a reminder in
 * a minute that fires once) and MCP (401 and metadata, a read, a write, a WhatsApp undo of that write). Every step asserts
 * on what the graph-sink recorded (the sends) and on the database (read through a read-only connection). Staging's Graph
 * calls go to the sink, so no phone is ever messaged.
 *
 * production: read-only. Health, the webhook verify handshake, the MCP 401 and its metadata, OAuth discovery. It sends no
 * message and writes nothing.
 *
 * Settings come from the environment (PROBE_*) or, when unset, from the Railway CLI of whoever runs it (`railway variables`,
 * read only). No secret is printed. The MCP token is minted from staging's own signing key (the real sign-in needs a client
 * metadata document on claude.ai, which a staging server will not fetch from anywhere else).
 */

import { execFileSync } from 'node:child_process'
import { createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import postgres from 'postgres'

type Vars = Record<string, string>
type Row = Record<string, unknown>

const railwayVars = (service: string, environment: string): Vars =>
  JSON.parse(
    execFileSync('railway', ['variables', '-s', service, '-e', environment, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )

const started = Date.now()
let failures = 0
async function step(name: string, fn: () => Promise<string | void>) {
  const t = Date.now()
  try {
    const note = await fn()
    console.log(`ok   ${name} (${Date.now() - t} ms)${note ? ` - ${note}` : ''}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | undefined | false>,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(500)
  }
}

/**
 * `--expect <build>`: wait until `/health` says this deploy answers: the `x-warren-build` header has a commit sha or
 * deployment id that starts with the one given, or, for `--expect v1`, the header is absent (v1 answers a plain `ok` and no build). A probe that
 * passes against the version being replaced proves nothing; this is what the cutover and the rollback wait on.
 */
async function expectBuild(healthUrl: string, expected: string, timeoutMs = 600_000) {
  await step(`health says build ${expected.slice(0, 12)}`, async () => {
    let last = 'no answer'
    await until(`${healthUrl} to report ${expected.slice(0, 12)}`, timeoutMs, async () => {
      try {
        const r = await fetch(healthUrl)
        const build = r.headers.get('x-warren-build')
        last =
          r.status === 200
            ? build
              ? `build ${build.slice(0, 12)}`
              : 'no build header (v1)'
            : `status ${r.status}`
        if (r.status !== 200) return false
        return expected === 'v1'
          ? !build
          : (build ?? '').split(' ').some((id) => id.startsWith(expected))
      } catch {
        return false
      }
    }).catch((err) => {
      throw new Error(`${err instanceof Error ? err.message : err}; the last answer was: ${last}`)
    })
  })
}
const expected = (() => {
  const i = process.argv.indexOf('--expect')
  return i >= 0 ? process.argv[i + 1] : undefined
})()

// ---------------------------------------------------------------------------------------------- production (read only)

async function production() {
  const env = process.env.PROBE_ENVIRONMENT ?? 'production'
  const v = railwayVars('warren', env)
  const publicUrl = (process.env.PROBE_PUBLIC_URL ?? v.PUBLIC_URL ?? '').replace(/\/$/, '')
  const webhookUrl = (process.env.PROBE_WEBHOOK_URL ?? 'https://wa.heywarren.app').replace(
    /\/$/,
    '',
  )
  assert(publicUrl, 'no PUBLIC_URL')
  if (expected) await expectBuild(`${webhookUrl}/health`, expected)
  await mcpAndOAuth(publicUrl)
  await step('health', async () => {
    const r = await fetch(`${webhookUrl}/health`)
    assert(r.status === 200, `status ${r.status}`)
  })
  await step('webhook verify handshake', async () => {
    const q = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': v.WHATSAPP_VERIFY_TOKEN ?? '',
      'hub.challenge': 'probe-123',
    })
    const r = await fetch(`${webhookUrl}/webhook?${q}`)
    assert(r.status === 200 && (await r.text()) === 'probe-123', `status ${r.status}`)
    const bad = await fetch(
      `${webhookUrl}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`,
    )
    assert(bad.status === 403, `a wrong token answered ${bad.status}`)
  })
}

/** What an unauthenticated client sees; shared by both modes. */
async function mcpAndOAuth(base: string) {
  await step('mcp: 401 with a challenge and metadata, no token', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert(r.status === 401, `status ${r.status}`)
    const meta = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') ?? '')?.[1]
    assert(meta, 'no resource_metadata in WWW-Authenticate')
    const doc = (await (await fetch(meta)).json()) as {
      resource?: string
      authorization_servers?: string[]
    }
    assert(doc.resource === `${base}/mcp`, 'resource metadata names another resource')
    assert(doc.authorization_servers?.length, 'no authorization server')
  })
  await step('oauth: discovery', async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    assert(r.status === 200, `status ${r.status}`)
    const d = (await r.json()) as Record<string, unknown>
    assert(d.client_id_metadata_document_supported === true, 'CIMD not advertised')
    assert(
      typeof d.authorization_endpoint === 'string' && typeof d.token_endpoint === 'string',
      'endpoints missing',
    )
  })
}

// ------------------------------------------------------------------------------------------------------------ staging

async function staging() {
  const env = process.env.PROBE_ENVIRONMENT ?? 'staging'
  const app = railwayVars('warren', env)
  const sinkVars = railwayVars('graph-sink', env)
  const pg = railwayVars('Postgres', env)
  const base = (process.env.PROBE_URL ?? app.PUBLIC_URL ?? '').replace(/\/$/, '')
  const sinkUrl = (
    process.env.PROBE_SINK_URL ?? `https://${sinkVars.RAILWAY_PUBLIC_DOMAIN}`
  ).replace(/\/$/, '')
  assert(base && sinkUrl && pg.DATABASE_PUBLIC_URL, 'staging settings missing')
  assert(!app.REMINDER_TEMPLATE, 'staging must not have REMINDER_TEMPLATE')
  assert(sinkVars.SINK_TOKEN, 'the graph-sink has no SINK_TOKEN: /sent would be open')
  if (expected) await expectBuild(`${base}/health`, expected)
  const GRAPH_BASE = app.GRAPH_BASE_URL ?? ''
  assert(GRAPH_BASE.includes('graph-sink'), 'staging GRAPH_BASE_URL does not point at the sink')

  // Read only for every assertion; the one write (an auth user for the MCP token) uses `admin`.
  const ro = postgres(pg.DATABASE_PUBLIC_URL, {
    max: 2,
    connection: { default_transaction_read_only: true },
  })
  const admin = postgres(pg.DATABASE_PUBLIC_URL, { max: 1 })
  const q = <T extends Row>(strings: TemplateStringsArray, ...args: unknown[]) =>
    ro<T[]>(strings, ...(args as never[]))

  // The first synthetic number on staging's allowlist that has never written: every run starts from an empty account.
  // Staging's allowlist holds only such numbers, and its Graph is the sink, so none of them is ever messaged.
  const pool = (app.ALLOWED_WA_IDS ?? '').split(',').filter(Boolean)
  assert(
    pool.length > 0 && pool.every((n) => /^54911000\d{6}$/.test(n)),
    'staging allowlist is not synthetic numbers',
  )
  const usedRows = await ro<{ wa_id: string }[]>`SELECT DISTINCT wa_id FROM wa_message`
  const used = new Set(usedRows.map((r) => r.wa_id))
  const WA = pool.find((n) => !used.has(n)) ?? ''
  assert(WA, 'every synthetic number on the allowlist has been used: extend ALLOWED_WA_IDS')

  // --- the sink
  let cursor = 0
  const sinkGet = async (since: number) => {
    const r = await fetch(`${sinkUrl}/sent?since=${since}`, {
      headers: { authorization: `Bearer ${sinkVars.SINK_TOKEN}` },
    })
    assert(r.ok, `sink /sent ${r.status}`)
    return (await r.json()) as {
      last: number
      sent: { seq: number; kind: string; to?: string; body: string }[]
    }
  }
  cursor = (await sinkGet(0)).last
  await step('graph-sink: /sent refuses a request with no token', async () => {
    const r = await fetch(`${sinkUrl}/sent`)
    assert(r.status === 401, `status ${r.status}`)
  })

  // --- WhatsApp
  const sig = (raw: string) =>
    `sha256=${createHmac('sha256', app.META_APP_SECRET ?? '')
      .update(raw)
      .digest('hex')}`
  const webhook = (wamid: string, extra: Row) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: wamid,
                    from: WA,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    ...extra,
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  const post = (raw: string, signature = sig(raw)) =>
    fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    })

  /** Sends one signed webhook and returns the texts Warren sent back (waiting for the first one), and the wamid. */
  async function say(extra: Row, wait = 60_000) {
    const wamid = `wamid.PROBE${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const since = cursor
    const res = await post(webhook(wamid, extra))
    assert(res.status === 200, `webhook answered ${res.status}`)
    const sent = await until(`a reply to ${JSON.stringify(extra).slice(0, 60)}`, wait, async () => {
      const s = await sinkGet(since)
      const texts = s.sent.filter((x) => x.kind === 'text' && x.to === WA)
      if (!texts.length) return false
      cursor = s.last
      return s.sent
    })
    // The message is settled when the worker marks it done; the sink saw the send first.
    await until(`wa_message ${wamid} done`, 15_000, async () => {
      const [m] = await q<{ status: string }>`SELECT status FROM wa_message WHERE wamid = ${wamid}`
      return m?.status === 'done' ? m : false
    })
    return {
      wamid,
      sent,
      texts: sent.filter((x) => x.kind === 'text').map((x) => x.body),
      typing: sent.some((x) => x.kind === 'typing'),
    }
  }
  const text = (body: string) => say({ text: { body } })

  const live = () =>
    q<{ entity_id: string; amount: string; description: string }>`
      SELECT m.entity_id, m.amount::text AS amount, m.description FROM movement m
      JOIN account_address ad ON ad.account_id = m.account_id AND ad.address = ${WA}
      WHERE m.ended_at IS NULL ORDER BY m.entity_id`
  const sameNumber = (a: string, b: number) => Number(a) === b

  await step('health', async () => {
    const r = await fetch(`${base}/health`)
    assert(r.status === 200, `status ${r.status}`)
  })
  await step('webhook verify handshake, and a bad signature is refused', async () => {
    const q2 = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': app.WHATSAPP_VERIFY_TOKEN ?? '',
      'hub.challenge': 'c-42',
    })
    const r = await fetch(`${base}/webhook?${q2}`)
    assert(r.status === 200 && (await r.text()) === 'c-42', `handshake ${r.status}`)
    const raw = webhook('wamid.PROBEBAD', { text: { body: 'café 1' } })
    assert(
      (await post(raw, `sha256=${'0'.repeat(64)}`)).status === 401,
      'a bad signature was not refused',
    )
  })

  let first = ''
  await step('log: "café 3500" is recorded, signalled and answered', async () => {
    const r = await text('café 3500')
    assert(r.typing, 'no typing indicator reached the sink')
    first = r.texts.join('\n')
    const rows = await live()
    assert(
      rows.length === 1 && sameNumber(rows[0]?.amount ?? '', 3500),
      `live movements: ${JSON.stringify(rows.map((x) => x.amount))}`,
    )
    assert(first.includes('3.500'), 'the reply does not show 3.500')
  })
  await step('correct: "no, fue 3800" supersedes it (one live row, two versions)', async () => {
    await text('no, el café fue 3800')
    const rows = await live()
    assert(
      rows.length === 1 && sameNumber(rows[0]?.amount ?? '', 3800),
      `live: ${JSON.stringify(rows.map((x) => x.amount))}`,
    )
    const [v] = await q<{
      n: string
    }>`SELECT count(*)::text AS n FROM movement WHERE entity_id = ${rows[0]?.entity_id ?? '0'}`
    assert(v?.n === '2', `versions: ${v?.n}`)
  })
  await step('undo: "deshacer" restores 3500, and it is a turn that undoes', async () => {
    await text('deshacer')
    const rows = await live()
    assert(
      rows.length === 1 && sameNumber(rows[0]?.amount ?? '', 3500),
      `live: ${JSON.stringify(rows.map((x) => x.amount))}`,
    )
    const [u] = await q<{
      n: string
    }>`SELECT count(*)::text AS n FROM turn WHERE undoes IS NOT NULL`
    assert(Number(u?.n) >= 1, 'no undo turn recorded')
  })
  await step('question then answer: "forget everything" asks, "sí" answers', async () => {
    await text('acordate que "el chino" es un supermercado')
    const liveFacts = () =>
      q<{
        n: string
      }>`SELECT count(*)::text AS n FROM fact f JOIN account_address ad ON ad.account_id = f.account_id AND ad.address = ${WA} WHERE f.ended_at IS NULL`
    assert(Number((await liveFacts())[0]?.n) >= 1, 'the fact was not stored')
    const r = await text('olvidate de todo lo que sabés de mí')
    const [t] = await q<{ question: unknown }>`
      SELECT t.question FROM turn t JOIN account_address ad ON ad.account_id = t.account_id AND ad.address = ${WA}
      WHERE t.question IS NOT NULL ORDER BY t.id DESC LIMIT 1`
    assert(t?.question, `no question was asked; replies: ${JSON.stringify(r.texts)}`)
    assert(Number((await liveFacts())[0]?.n) >= 1, 'the facts were forgotten before the answer')
    await text('sí')
    assert(Number((await liveFacts())[0]?.n) === 0, 'the answer did not forget the facts')
  })
  await step(
    'voice fixture: the note is fetched from the sink, transcribed and logged',
    async () => {
      await say({
        type: 'audio',
        audio: { id: 'fixture-voice', mime_type: 'audio/ogg; codecs=opus', voice: true },
      })
      const [m] = await q<{
        kind: string
        status: string
      }>`SELECT kind, status FROM wa_message WHERE media_id = 'fixture-voice' ORDER BY id DESC LIMIT 1`
      assert(m?.kind === 'audio' && m.status === 'done', `wa_message: ${JSON.stringify(m)}`)
      assert(
        (await live()).some((x) => sameNumber(x.amount, 2500)),
        'no live movement of 2500 from the voice note',
      )
    },
  )
  await step('photo fixture: the receipt is fetched from the sink and logged', async () => {
    await say({
      type: 'image',
      image: { id: 'fixture-photo', mime_type: 'image/png', caption: 'gasto' },
    })
    const [m] = await q<{
      status: string
    }>`SELECT status FROM wa_message WHERE media_id = 'fixture-photo' ORDER BY id DESC LIMIT 1`
    assert(m?.status === 'done', `wa_message: ${JSON.stringify(m)}`)
    assert(
      (await live()).some((x) => sameNumber(x.amount, 4500)),
      'no live movement of 4500 from the photo',
    )
  })

  let reminderEntity = ''
  await step('reminder: set in 1 minute (live, with next_due_at)', async () => {
    await text('recordame en 1 minuto que tengo que tomar agua')
    const [r] = await q<{ entity_id: string; next_due_at: Date | null }>`
      SELECT r.entity_id::text, r.next_due_at FROM reminder r JOIN account_address ad ON ad.account_id = r.account_id AND ad.address = ${WA}
      WHERE r.ended_at IS NULL ORDER BY r.id DESC LIMIT 1`
    assert(r?.next_due_at, 'no live reminder with next_due_at')
    reminderEntity = r.entity_id
    const ms = r.next_due_at.getTime() - Date.now()
    assert(ms > -10_000 && ms < 120_000, `next_due_at is ${Math.round(ms / 1000)} s away`)
  })

  // MCP, while the reminder's minute passes.
  await mcpAndOAuth(base)
  let bearer = ''
  const rpc = async (method: string, params: unknown = {}, token = bearer) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
    })
    const raw = await r.text()
    const data =
      raw.startsWith('event:') || raw.includes('\ndata:')
        ? (raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .at(-1) ?? 'null')
        : raw
    return {
      status: r.status,
      body: JSON.parse(data || 'null') as {
        result?: { isError?: boolean; structuredContent?: Row }
        error?: unknown
      },
    }
  }
  const tool = async (name: string, args: Row = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    assert(
      r.status === 200 && !r.body.error,
      `${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
    )
    assert(
      !r.body.result?.isError,
      `${name} refused: ${JSON.stringify(r.body.result?.structuredContent).slice(0, 200)}`,
    )
    return r.body.result?.structuredContent ?? {}
  }

  await step("mcp: a token minted from staging's signing key is accepted", async () => {
    // The JWKS endpoint creates the signing key on first use.
    await fetch(`${base}/api/auth/jwks`)
    const [key] = await ro<
      { id: string; private: string }[]
    >`SELECT id, "privateKey" AS private FROM auth_jwks ORDER BY "createdAt" DESC LIMIT 1`
    assert(key, 'no signing key in auth_jwks')
    const [account] = await q<{
      account_id: string
    }>`SELECT account_id::text FROM account_address WHERE channel = 'whatsapp' AND address = ${WA}`
    assert(account, 'the WhatsApp steps left no account')
    const email = `probe-${account.account_id}@users.invalid`
    const [user] = await admin<{ id: string }[]>`
      INSERT INTO auth_user (name, email, "emailVerified", warren_account_id) VALUES ('probe', ${email}, true, ${account.account_id})
      ON CONFLICT (email) DO UPDATE SET "updatedAt" = now() RETURNING id`
    assert(user, 'could not create the probe user')
    const secret = app.BETTER_AUTH_SECRET ?? ''
    const jwk = JSON.parse(await symmetricDecrypt({ key: secret, data: JSON.parse(key.private) }))
    const now = Math.floor(Date.now() / 1000)
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: key.id })}.${b64({
      iss: base,
      aud: `${base}/mcp`,
      sub: user.id,
      azp: 'https://claude.ai/oauth/probe.json',
      scope: 'ledger:read ledger:write',
      iat: now,
      exp: now + 900,
    })}`
    bearer = `${input}.${sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: 'jwk' })).toString('base64url')}`
    const list = await rpc('tools/list')
    assert(list.status === 200, `tools/list ${list.status}`)
    const names = (
      (list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []
    ).map((t) => t.name)
    assert(names.includes('warren_log_movements'), `tools: ${names.join(',')}`)
    const bad = await rpc('tools/list', {}, `${bearer.slice(0, -4)}AAAA`)
    assert(bad.status === 401, `a tampered token answered ${bad.status}`)
  })
  await step('mcp: read, then write (replayable), then WhatsApp undoes the write', async () => {
    const before = await tool('warren_find_movements')
    assert(Array.isArray(before.movements), 'find_movements returned no list')
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(new Date())
    const request_id = randomUUID()
    const args = {
      movements: [
        {
          direction: 'out',
          amount: '777',
          currency: 'ARS',
          date: today,
          description: 'probe mcp',
          category: 'otros',
          confidence: 'high',
        },
      ],
      request_id,
    }
    const written = await tool('warren_log_movements', args)
    assert(written.replayed === false, 'the first write was reported as a replay')
    assert(
      (await live()).some((x) => sameNumber(x.amount, 777)),
      'the MCP write is not a live movement',
    )
    assert(
      (await tool('warren_log_movements', args)).replayed === true,
      'the same request_id was not a replay',
    )
    const [n] = await q<{
      n: string
    }>`SELECT count(*)::text AS n FROM movement m JOIN account_address ad ON ad.account_id = m.account_id AND ad.address = ${WA} WHERE m.description = 'probe mcp'`
    assert(n?.n === '1', `the replay wrote again: ${n?.n}`)
    await text('deshacer')
    assert(
      !(await live()).some((x) => sameNumber(x.amount, 777)),
      'the WhatsApp undo left the MCP write live',
    )
  })

  await step('reminder: fires once', async () => {
    await until('the reminder to be sent', 150_000, async () => {
      const [s] = await q<{
        n: string
      }>`SELECT count(*)::text AS n FROM reminder_send WHERE reminder_entity_id = ${reminderEntity} AND status = 'sent'`
      return Number(s?.n) >= 1 ? s : false
    })
    const s = await sinkGet(0)
    const agua = s.sent.filter((x) => x.kind === 'text' && x.to === WA && /agua/i.test(x.body))
    assert(
      agua.length >= 2,
      `the sink saw ${agua.length} texts about the reminder (the confirmation and the reminder itself)`,
    )
    await sleep(20_000) // another sweep must not send it again
    const [after] = await q<{
      n: string
    }>`SELECT count(*)::text AS n FROM reminder_send WHERE reminder_entity_id = ${reminderEntity}`
    assert(after?.n === '1', `reminder_send rows: ${after?.n}`)
    const [due] = await q<{
      next_due_at: Date | null
    }>`SELECT next_due_at FROM reminder WHERE entity_id = ${reminderEntity} AND ended_at IS NULL`
    assert(!due?.next_due_at || due.next_due_at.getTime() > Date.now(), 'the one-off is still due')
  })

  await ro.end()
  await admin.end()
}

const mode = process.argv[2]
if (mode !== 'staging' && mode !== 'production') {
  console.error('usage: pnpm probe staging|production [--expect <commit sha, deployment id or v1>]')
  process.exit(2)
}
console.log(`probe ${mode}`)
await (mode === 'staging' ? staging() : production())
console.log(
  `${failures ? 'FAILED' : 'passed'}: ${failures} failure(s) in ${Math.round((Date.now() - started) / 1000)} s`,
)
process.exit(failures ? 1 : 0)
