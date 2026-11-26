/**
 * `pnpm probe [--expect <commit sha or deployment id>]`: production, checked from outside. Read-only: health, the webhook
 * verify handshake, the MCP 401 and its metadata, OAuth discovery. It sends no message and writes nothing.
 *
 * Settings come from the environment (PROBE_*) or, when unset, from the Railway CLI of whoever runs it (`railway variables`,
 * read only). No secret is printed.
 */

import { execFileSync } from 'node:child_process'

type Vars = Record<string, string>

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
 * deployment id that starts with the one given. A probe that passes against the version being replaced proves nothing.
 * It takes 3 matching answers in a row, a second apart: Railway's edge answered 404 for a moment right after a new build first
 * answered, so one match is not enough to start the read-only steps.
 */
const CONSECUTIVE_MATCHES = 3
const MATCH_GAP_MS = 1000
async function expectBuild(healthUrl: string, expected: string, timeoutMs = 600_000) {
  await step(`health says build ${expected.slice(0, 12)}`, async () => {
    let last = 'no answer'
    let streak = 0
    await until(`${healthUrl} to report ${expected.slice(0, 12)}`, timeoutMs, async () => {
      try {
        const r = await fetch(healthUrl)
        const build = r.headers.get('x-warren-build')
        last =
          r.status === 200
            ? build
              ? `build ${build.slice(0, 12)}`
              : 'no build header'
            : `status ${r.status}`
        const matches =
          r.status === 200 && (build ?? '').split(' ').some((id) => id.startsWith(expected))
        streak = matches ? streak + 1 : 0
        if (streak >= CONSECUTIVE_MATCHES) return true
        // `until` waits 500 ms after a false; a match waits another 500 so the answers are a second apart.
        if (matches) await sleep(MATCH_GAP_MS - 500)
        return false
      } catch {
        streak = 0
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

/** What an unauthenticated client sees. */
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

console.log('probe production')
await production()
console.log(
  `${failures ? 'FAILED' : 'passed'}: ${failures} failure(s) in ${Math.round((Date.now() - started) / 1000)} s`,
)
process.exit(failures ? 1 : 0)
