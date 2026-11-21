import { describe, expect, it } from 'vitest'
import { createGraph, GraphError, shortRecipient } from './graph'

describe('shortRecipient', () => {
  it('drops the mobile digit from Argentine and Mexican wa_ids', () => {
    expect(shortRecipient('5493515138578')).toBe('543515138578')
    expect(shortRecipient('5491123456789')).toBe('541123456789')
    expect(shortRecipient('5215512345678')).toBe('525512345678')
  })

  it('leaves every other number alone', () => {
    expect(shortRecipient('543515138578')).toBe('543515138578')
    expect(shortRecipient('15551439243')).toBe('15551439243')
    expect(shortRecipient('34612345678')).toBe('34612345678')
    expect(shortRecipient('54935151385789')).toBe('54935151385789')
  })
})

describe('createGraph', () => {
  const fakeGraph = (allowed: (to: string) => boolean) => {
    const tos: string[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      fetch: async (_url, init) => {
        const { to } = JSON.parse(String(init?.body))
        tos.push(to)
        if (!allowed(to))
          return new Response(JSON.stringify({ error: { message: 'not in list', code: 131030 } }), {
            status: 400,
          })
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${tos.length}` }] }))
      },
    })
    return { graph, tos }
  }

  it('sends to the wa_id when Meta accepts it', async () => {
    const { graph, tos } = fakeGraph(() => true)
    await expect(graph.sendText('5493515138578', 'hola')).resolves.toBe('wamid.1')
    expect(tos).toEqual(['5493515138578'])
  })

  it('retries once with the short form after 131030, then remembers it', async () => {
    const { graph, tos } = fakeGraph((to) => to === '543515138578')
    await expect(graph.sendText('5493515138578', 'a')).resolves.toBe('wamid.2')
    await expect(graph.sendText('5493515138578', 'b')).resolves.toBe('wamid.3')
    expect(tos).toEqual(['5493515138578', '543515138578', '543515138578'])
  })

  it('does not retry a 131030 for a number with no short form', async () => {
    const { graph, tos } = fakeGraph(() => false)
    await expect(graph.sendText('34612345678', 'a')).rejects.toMatchObject({ code: 131030 })
    expect(tos).toEqual(['34612345678'])
  })

  it('reacts with the same fallback, to the wa_id first and then the short form', async () => {
    const sent: unknown[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        sent.push(body)
        if (body.to === '5493515138578')
          return new Response(JSON.stringify({ error: { message: 'not in list', code: 131030 } }), {
            status: 400,
          })
        return new Response('{}')
      },
    })
    await graph.sendReaction('5493515138578', 'wamid.IN', '✅')
    await graph.sendReaction('5493515138578', 'wamid.IN2', '✅')
    const reaction = (to: string, id: string) => ({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: id, emoji: '✅' },
    })
    expect(sent).toEqual([
      reaction('5493515138578', 'wamid.IN'),
      reaction('543515138578', 'wamid.IN'),
      reaction('543515138578', 'wamid.IN2'),
    ])
  })

  it('shares what it learned about a number between texts and reactions', async () => {
    const { graph, tos } = fakeGraph((to) => to === '543515138578')
    await graph.sendText('5493515138578', 'a')
    await graph.sendReaction('5493515138578', 'wamid.X', '✅')
    expect(tos).toEqual(['5493515138578', '543515138578', '543515138578'])
  })

  it('treats a recipient-list rejection as permanent', () => {
    const e = new GraphError(400, 'Recipient phone number not in allowed list', 131030)
    expect(e.notSent).toBe(true)
    expect(e.retryable).toBe(false)
  })
})
