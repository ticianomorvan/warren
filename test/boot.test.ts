import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWarren } from '../src/warren'
import { sql, useDatabase } from './db'
import { fakeGraph, fakeModel } from './fakes'

useDatabase()

describe('createWarren', () => {
  let base = ''
  let warren: ReturnType<typeof createWarren>
  beforeAll(async () => {
    warren = createWarren({
      sql,
      config: {
        WHATSAPP_VERIFY_TOKEN: 'verify-token-123',
        META_APP_SECRET: 'app-secret',
        ALLOWED_WA_IDS: ['*'],
        HELP_CONTACT: undefined,
        REMINDER_TEMPLATE: undefined,
      },
      graph: fakeGraph().graph,
      client: fakeModel().client,
    })
    await new Promise<void>((r) => warren.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(warren.server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await warren.stop(1000)
    await new Promise((r) => warren.server.close(r))
  })

  it('boots on a migrated database and answers /health with 200', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
  })

  it('answers the webhook handshake and refuses an unsigned post', async () => {
    const ok = await fetch(
      `${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-token-123&hub.challenge=abc`,
    )
    expect([ok.status, await ok.text()]).toEqual([200, 'abc'])
    const bad = await fetch(`${base}/webhook`, { method: 'POST', body: '{}' })
    expect(bad.status).toBe(401)
  })

  it('has a sweep that runs on an empty database', async () => {
    await expect(warren.sweep()).resolves.toBeUndefined()
  })
})
