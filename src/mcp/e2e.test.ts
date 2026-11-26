import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cafe } from '../../test/core'
import {
  type App,
  CLIENT_ID,
  type Connected,
  claims,
  EMAIL_A,
  mint,
  withClaude,
} from '../auth-test-kit'
import { call, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'
import { INSTRUCTIONS } from './endpoint'

/**
 * The whole product across the door, once: a client that is a metadata document (CIMD) finds the server, the person signs in with Google
 * and consents, a token is issued, and with it `tools/list`, a read, a write and the replay of that write. Then two clients share one
 * undo stack.
 */
useDatabase({ max: 12 })

let app: App
let a: Connected

beforeEach(async () => {
  ;({ app } = await withClaude())
})
afterEach(() => app.close())

describe('OAuth and MCP, end to end', () => {
  it('discovery, Google sign-in, consent, a token, tools/list, a read, a write and its replay', async () => {
    // Unauthenticated: 401 and the RFC 9728 metadata a client follows.
    const challenge = await rpc(app, null, 'tools/list')
    expect(challenge.status).toBe(401)
    const metadataUrl =
      /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')?.[1] ?? ''
    const resource = (await (await fetch(metadataUrl)).json()) as {
      resource: string
      authorization_servers: string[]
    }
    expect(resource.resource).toBe(`${app.base}/mcp`)
    const server = (await (
      await fetch(`${app.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>
    expect(server.client_id_metadata_document_supported).toBe(true)
    expect(server.registration_endpoint).toMatch(/\/api\/auth\/oauth2\/register$/)
    // Claude registers by its metadata document only when both are said: CIMD supported, and public clients ("none") accepted.
    expect(server.token_endpoint_auth_methods_supported).toContain('none')

    // The CIMD client (a fake claude.ai document), the sign-in with Google, the consent page's grant, the token.
    a = await mint(app, EMAIL_A)
    const token = claims(a.access_token)
    expect(token).toMatchObject({ azp: CLIENT_ID, aud: `${app.base}/mcp`, iss: app.base })
    expect(token.scope).toContain('ledger:write')

    const list = await rpc(app, a.access_token, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.body?.result.tools.map((t: { name: string }) => t.name)).toContain(
      'warren_log_movements',
    )

    expect(
      ok(await call(app, a.access_token, 'warren_find_movements'), 'find_movements').movements,
    ).toEqual([])
    const request_id = randomUUID()
    const args = {
      movements: [{ ...cafe({ date: TODAY }), description: 'medialunas', amount: '2800' }],
      request_id,
    }
    const written = ok(
      await call(app, a.access_token, 'warren_log_movements', args),
      'log_movements',
    )
    expect(written.record).toContain('Medialunas')
    expect(written.replayed).toBe(false)
    const seen = ok(await call(app, a.access_token, 'warren_find_movements'), 'find_movements')
    expect(seen.movements.map((m) => [m.description, m.display])).toEqual([
      ['medialunas', '$2.800'],
    ])

    // The same request_id again: the first answer, and nothing written twice.
    const replay = ok(
      await call(app, a.access_token, 'warren_log_movements', args),
      'log_movements',
    )
    expect(replay).toEqual({ ...written, replayed: true })
    expect(await sql`SELECT 1 FROM movement`).toHaveLength(1)
    refused(
      await call(app, a.access_token, 'warren_log_movements', {
        ...args,
        movements: [{ ...args.movements[0], amount: '1' }],
      }),
      'request_id_reused',
    )
  })
})

describe('what a client is told on connect', () => {
  it('carries the rules in the first 512 characters, for any agent, with no chat app named', async () => {
    a = await mint(app, EMAIL_A)
    const init = await rpc(app, a.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    const told = init.body?.result.instructions as string
    expect(told).toBe(INSTRUCTIONS)
    const head = told.slice(0, 512)
    expect(head).toMatch(/never add, convert or round money/)
    expect(head).toMatch(/warren_summarize/)
    expect(head).toMatch(/ask before/)
    expect(told).not.toMatch(/whatsapp|deshacer/i)
  })
})

describe('one undo for every client', () => {
  beforeEach(async () => {
    a = await mint(app, EMAIL_A)
  })

  it('records the OAuth client on the turn, and an undo takes back the newest change whichever client made it', async () => {
    const written = ok(
      await call(app, a.access_token, 'warren_log_movements', {
        movements: [{ ...cafe({ date: TODAY }), description: 'kiosco' }],
      }),
      'log_movements',
    )
    const [row] = await sql`SELECT client FROM turn WHERE id = ${written.turn ?? 0}`
    expect(row?.client).toBe(CLIENT_ID)
    // A second client of the same person (the import command): its turn is the newest, and an agent's undo takes it back.
    await sql`INSERT INTO turn (account_id, client, calls)
      SELECT account_id, 'cli', '[]' FROM turn WHERE id = ${written.turn ?? 0}`
    const undone = ok(await call(app, a.access_token, 'warren_undo_last'), 'undo_last')
    expect(undone.undone_turn).toBe(written.turn)
  })
})
