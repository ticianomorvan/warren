import { createPrivateKey, sign } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { expect } from 'vitest'
import type { z } from 'zod'
import { mcpUrl } from './auth/config'
import type { App } from './auth-test-kit'
import { CLIENT_ID } from './auth-test-kit'
import { outputSchemas } from './mcp/tools'
import { sql } from './test-harness'

/** Shared by the MCP tests: JSON-RPC over HTTP, tokens forged with the real signing key, seeding rows and facts. */

// biome-ignore lint/suspicious/noExplicitAny: a test reads JSON-RPC answers loosely
export type Json = any

export type Rpc = { status: number; headers: Headers; body: Record<string, Json> | null }

/** The answer is JSON or, for a legacy client, one SSE `message` event: both read the same. */
export async function readBody(res: Response): Promise<Record<string, Json> | null> {
  const text = await res.text()
  if (!text) return null
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .at(-1)
    return data ? JSON.parse(data) : null
  }
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

let id = 0

export async function rpc(
  app: App,
  bearer: string | null,
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) {
  const res = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  return { status: res.status, headers: res.headers, body: await readBody(res) } satisfies Rpc
}

export type ToolResult = {
  isError?: boolean
  structuredContent?: Json
  content: { type: string; text: string }[]
}
export const call = async (
  app: App,
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> => {
  const r = await rpc(app, bearer, 'tools/call', { name, arguments: args })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body?.error, JSON.stringify(r.body)).toBeUndefined()
  return r.body?.result as ToolResult
}

export const closed = outputSchemas(true)
/** A good result: held to the closed copy of its schema, and its text is the same data as its structured content. */
export function ok<K extends keyof typeof closed>(
  result: ToolResult,
  schema: K,
): z.infer<(typeof closed)[K]> {
  expect(result.isError, JSON.stringify(result)).toBeFalsy()
  const parsed = closed[schema].parse(result.structuredContent)
  expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(parsed)
  return parsed as z.infer<(typeof closed)[K]>
}
export const refusal = (result: ToolResult) => {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
  return result.content[0]?.text ?? ''
}

// ---- Data

export async function accountOf(wa: string): Promise<number> {
  const [row] = await sql`SELECT id::int AS id FROM account WHERE wa_id = ${wa}`
  return Number(row?.id)
}

export interface Row {
  on: string
  amount: string
  currency?: 'ARS' | 'USD'
  direction?: 'in' | 'out'
  description: string
  category?: string
  payment?: string | null
  at?: string
  state?: 'live' | 'deleted' | 'replaced'
}

let seeds = 0
export async function seed(
  wa: string,
  rows: Row[],
  facts: { kind: string; key: string; value: string }[] = [],
) {
  const account = await accountOf(wa)
  const [inbound] = await sql`
    INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status)
    VALUES (${`seed.${wa}.${++seeds}`}, ${wa}, 'text', 'seed', '{}'::jsonb, 'done') RETURNING id`
  const ids: number[] = []
  for (const [position, r] of rows.entries()) {
    const [m] = await sql`
      INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on,
        description, category, payment, confidence, created_at, deleted_at, deleted_by)
      VALUES (${account}, ${inbound?.id}, ${position}, ${r.direction ?? 'out'}, ${r.amount}, ${r.currency ?? 'ARS'},
        ${r.on}, ${r.description}, ${r.category ?? 'otros'}, ${r.payment ?? null}, 'high',
        ${new Date(`${r.on}T${r.at ?? '10:00'}:00-03:00`)},
        ${r.state === 'deleted' ? new Date() : null}, ${r.state === 'deleted' ? inbound?.id : null})
      RETURNING id::int AS id`
    ids.push(Number(m?.id))
    if (r.state === 'replaced') {
      const [next] = await sql`
        INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency, occurred_on,
          description, category, payment, confidence)
        VALUES (${account}, ${inbound?.id}, ${rows.length + position}, 'out', '1', 'ARS', ${r.on}, 'corrected', 'otros', null, 'high')
        RETURNING id::int AS id`
      await sql`UPDATE movement SET superseded_by = ${next?.id} WHERE id = ${m?.id}`
      await sql`UPDATE movement SET deleted_at = now(), deleted_by = ${inbound?.id} WHERE id = ${next?.id}`
    }
  }
  if (facts.length > 0) {
    await sql`INSERT INTO fact ${sql(facts.map((f) => ({ ...f, account_id: account, inbound_message_id: inbound?.id })))}`
  }
  return ids
}

// ---- Tokens

/** A token as better-auth signs it, with any claim or header changed: the real signing key, taken out of the table. */
export async function forge(
  app: App,
  sub: string,
  over: {
    claims?: Record<string, unknown>
    header?: Record<string, unknown>
    sub?: string
    dropClaims?: string[]
  } = {},
) {
  const [key] =
    await sql`SELECT id, "privateKey" AS private FROM auth_jwks ORDER BY "createdAt" DESC LIMIT 1`
  const secret = (await (app.auth as NonNullable<typeof app.auth>).$context).secretConfig
  const jwk = JSON.parse(await symmetricDecrypt({ key: secret, data: JSON.parse(key?.private) }))
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: app.base,
    aud: mcpUrl(app.base),
    sub: over.sub ?? sub,
    azp: CLIENT_ID,
    scope: 'ledger:read ledger:write',
    iat: now,
    exp: now + 900,
    ...over.claims,
  }
  for (const k of over.dropClaims ?? []) delete payload[k]
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: key?.id, ...over.header })}.${b64(payload)}`
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: 'jwk' }))
  return `${input}.${signature.toString('base64url')}`
}
