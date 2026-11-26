import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWarren } from '../src/warren'
import { sql, useDatabase } from './db'

useDatabase()

describe('createWarren', () => {
  let base = ''
  let warren: ReturnType<typeof createWarren>
  beforeAll(async () => {
    warren = createWarren({ sql, config: {}, build: 'abc123' })
    await new Promise<void>((r) => warren.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(warren.server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((r) => warren.server.close(r))
  })

  it('boots on a migrated database and answers /health with 200', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    // Which deploy answers, and nothing else.
    expect(res.headers.get('x-warren-build')).toBe('abc123')
  })

  it('without PUBLIC_URL serves nothing else: no /mcp, no web, no webhook', async () => {
    for (const path of ['/mcp', '/', '/setup.md', '/webhook', '/account']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404)
    }
  })
})
