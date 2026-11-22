import { createPrivateKey, sign } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { expect } from 'vitest'
import type { z } from 'zod'
import { mcpUrl } from './auth/config'
import { type App, CLIENT_ID } from './auth-test-kit'
import { OUTPUTS } from './core/commands'
import { sql } from './test-harness'

/** Shared by the MCP tests: JSON-RPC over HTTP, tokens forged with the real signing key. */

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
): Promise<Rpc> {
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
  return { status: res.status, headers: res.headers, body: await readBody(res) }
}

export type ToolResult = {
  isError?: boolean
  structuredContent?: Json
  content: { type: string; text: string }[]
}

/** A `tools/call`: the HTTP and JSON-RPC layers must be fine (a refusal is an error result, not a protocol error). */
export async function call(
  app: App,
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const r = await rpc(app, bearer, 'tools/call', { name, arguments: args })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body?.error, JSON.stringify(r.body)).toBeUndefined()
  return r.body?.result as ToolResult
}

/** The registry's own output schemas, held to a result: a good result carries exactly what its schema says, and its text is the same data. */
export function ok<T extends keyof typeof OUTPUTS>(
  result: ToolResult,
  tool: T,
): z.infer<(typeof OUTPUTS)[T]> {
  expect(result.isError, JSON.stringify(result)).toBeFalsy()
  const parsed = OUTPUTS[tool].parse(result.structuredContent)
  expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(result.structuredContent)
  return parsed as never
}

/** A refusal: an error result with a typed `code` and the line Warren says. */
export function refused(result: ToolResult, code: string) {
  expect(result.isError, JSON.stringify(result)).toBe(true)
  expect(result.structuredContent?.code, JSON.stringify(result)).toBe(code)
  expect(typeof result.structuredContent?.message).toBe('string')
  return result.structuredContent?.message as string
}

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
