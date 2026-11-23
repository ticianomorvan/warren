import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createGraph } from '../../src/whatsapp/graph'
import { createSink } from './server'

const sink = createSink({ token: 't0k' })
let base = ''
beforeAll(async () => {
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => sink.close(r)))

const graph = () => createGraph({ version: 'v27.0', phoneNumberId: '1', token: 'x', baseUrl: base })
const sent = async (since = 0) =>
  (
    await fetch(`${base}/sent?since=${since}`, { headers: { authorization: 'Bearer t0k' } })
  ).json() as Promise<{
    last: number
    sent: { kind: string; to?: string; body: string }[]
  }>

test('records typing, text and template sends made through the real Graph client', async () => {
  await graph().markReadAndType('wamid.IN1')
  const id = await graph().sendText('5491100000001', 'hola')
  expect(id).toMatch(/^wamid\.SINK/)
  await graph().sendTemplate('5491100000001', 'warren_reminder', 'es_AR', ['x'])
  const { sent: s } = await sent()
  expect(s.map((x) => x.kind)).toEqual(['typing', 'text', 'template'])
  expect(s[1]).toMatchObject({ to: '5491100000001', body: 'hola' })
})

test('/sent needs the token and honours since', async () => {
  expect((await fetch(`${base}/sent`)).status).toBe(401)
  const { last } = await sent()
  expect((await sent(last)).sent).toEqual([])
})

test('serves the fixtures through the Graph client media path', async () => {
  expect((await graph().fetchImage('fixture-photo')).data.length).toBeGreaterThan(1000)
  expect((await graph().fetchAudio('fixture-voice')).bytes.length).toBeGreaterThan(1000)
  await expect(graph().fetchImage('nope')).rejects.toThrow(/media/)
})
