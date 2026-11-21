import { describe, expect, it } from 'vitest'
import { createGraph, GraphError, recipientFor } from './graph'

describe('recipientFor', () => {
  it('drops the mobile digit from Argentine and Mexican wa_ids', () => {
    expect(recipientFor('5493515138578')).toBe('543515138578')
    expect(recipientFor('5491123456789')).toBe('541123456789')
    expect(recipientFor('5215512345678')).toBe('525512345678')
  })

  it('leaves every other number alone', () => {
    expect(recipientFor('543515138578')).toBe('543515138578')
    expect(recipientFor('15551439243')).toBe('15551439243')
    expect(recipientFor('34612345678')).toBe('34612345678')
    expect(recipientFor('54935151385789')).toBe('54935151385789')
  })
})

describe('createGraph', () => {
  it('sends to the short recipient form and returns the wamid', async () => {
    const bodies: unknown[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }))
      },
    })
    await expect(graph.sendText('5493515138578', 'hola')).resolves.toBe('wamid.out')
    expect(bodies[0]).toMatchObject({ to: '543515138578', type: 'text', text: { body: 'hola' } })
  })

  it('treats a recipient-list rejection as permanent', () => {
    const e = new GraphError(400, 'Recipient phone number not in allowed list', 131030)
    expect(e.notSent).toBe(true)
    expect(e.retryable).toBe(false)
  })
})
