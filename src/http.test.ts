import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { keepAliveFetch } from './http'

const server = createServer(() => {
  // Never answers.
})
let url = ''
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe('keepAliveFetch', () => {
  it('cancels a call that never answers when its signal aborts', async () => {
    const f = keepAliveFetch()
    const started = Date.now()
    await expect(f(url, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(Date.now() - started).toBeLessThan(2000)
    const controller = new AbortController()
    const pending = f(url, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
