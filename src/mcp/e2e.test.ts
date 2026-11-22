import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cafe } from '../../test/core'
import {
  type App,
  CLIENT_ID,
  type Connected,
  claims,
  mint,
  WA_A,
  whatsapp,
  withClaude,
} from '../auth-test-kit'
import { call, ok, refused, rpc } from '../mcp-test-kit'
import { sql, TODAY, useDatabase } from '../test-harness'

/**
 * The whole product across the door, once: a client that is a metadata document (CIMD) finds the server, signs in by sending a code on
 * WhatsApp, the person consents, a token is issued, and with it `tools/list`, a read, a write and the replay of that write. Then the two
 * channels share one undo: WhatsApp's "deshacer" takes back the MCP write, and an MCP undo takes back a WhatsApp write.
 */
useDatabase({ max: 12 })

let app: App
let a: Connected

beforeEach(async () => {
  ;({ app } = await withClaude({ allowed: [WA_A] }))
})
afterEach(() => app.close())

describe('OAuth and MCP, end to end', () => {
  it('discovery, sign-in by code, consent, a token, tools/list, a read, a write and its replay', async () => {
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
    expect(server.registration_endpoint).toBeUndefined()

    // The CIMD client (a fake claude.ai document), the sign-in by code on WhatsApp, the consent page's grant, the token.
    a = await mint(app, WA_A)
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

describe('one undo for both channels', () => {
  beforeEach(async () => {
    a = await mint(app, WA_A)
  })

  it('WhatsApp "deshacer" takes back an MCP write, with no model call', async () => {
    const written = ok(
      await call(app, a.access_token, 'warren_log_movements', {
        movements: [{ ...cafe({ date: TODAY }), description: 'kiosco' }],
      }),
      'log_movements',
    )
    const before = app.model.n
    const [reply] = await whatsapp(app, WA_A, 'deshacer')
    expect(reply).toContain('Deshice')
    expect(reply).toContain('Kiosco')
    expect(app.model.n).toBe(before)
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(0)
    // The undo is a turn of its own, on WhatsApp, that points at the MCP turn it took back.
    const [undo] =
      await sql`SELECT channel, undoes::int AS undoes FROM turn WHERE undoes IS NOT NULL`
    expect(undo).toEqual({ channel: 'whatsapp', undoes: written.turn })
  })

  it('an MCP undo takes back a WhatsApp write, and names what came back', async () => {
    const [reply] = await whatsapp(app, WA_A, 'café 3500')
    expect(reply).toContain('Café')
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(1)
    const undone = ok(await call(app, a.access_token, 'warren_undo_last'), 'undo_last')
    expect(undone.items).toMatchObject([
      { kind: 'logged', movement: { description: 'café', amount: '3500' } },
    ])
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(0)
    refused(await call(app, a.access_token, 'warren_undo_last'), 'nothing')
  })

  it('takes the newest turn of either channel, in order', async () => {
    await whatsapp(app, WA_A, 'café 3500') // 1: WhatsApp
    ok(
      await call(app, a.access_token, 'warren_log_movements', {
        movements: [{ ...cafe({ date: TODAY }), description: 'taxi' }],
      }),
      'log_movements',
    ) // 2: MCP
    ok(
      await call(app, a.access_token, 'warren_remember_fact', {
        kind: 'note',
        key: 'cobro',
        value: 'el 5',
      }),
      'remember_fact',
    ) // 3: MCP
    expect((await whatsapp(app, WA_A, 'deshacer'))[0]).toContain('cobro') // undoes 3 from WhatsApp
    const second = ok(await call(app, a.access_token, 'warren_undo_last'), 'undo_last') // undoes 2 from MCP
    expect(second.items[0]).toMatchObject({ kind: 'logged', movement: { description: 'taxi' } })
    expect((await whatsapp(app, WA_A, 'deshacer'))[0]).toContain('Deshice') // undoes 1 from WhatsApp
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(0)
  })
})
