import { describe, expect, it } from 'vitest'
import { parseWebhook } from './payload'

const webhook = (message: object) => ({
  entry: [{ changes: [{ value: { messages: [message] } }] }],
})

describe('parseWebhook', () => {
  it('reads a text message', () => {
    const { messages } = parseWebhook(
      webhook({ id: 'w1', from: '549', type: 'text', text: { body: 'café 3500' } }),
    )
    expect(messages).toEqual([
      { id: 'w1', from: '549', type: 'text', text: 'café 3500', mediaId: null, contextId: null },
    ])
  })

  it('reads a photo: its media id and caption, never bytes', () => {
    const { messages } = parseWebhook(
      webhook({
        id: 'w2',
        from: '549',
        type: 'image',
        image: { id: '9988', mime_type: 'image/jpeg', sha256: 'abc', caption: 'anotá este ticket' },
      }),
    )
    expect(messages).toMatchObject([{ type: 'image', text: 'anotá este ticket', mediaId: '9988' }])
  })

  it('reads a photo with no caption', () => {
    const { messages } = parseWebhook(
      webhook({ id: 'w3', from: '549', type: 'image', image: { id: '1' } }),
    )
    expect(messages).toMatchObject([{ text: null, mediaId: '1' }])
  })

  it('reads a voice note: its media id, stored at ingest to download it later', () => {
    const { messages } = parseWebhook(
      webhook({
        id: 'w5',
        from: '549',
        type: 'audio',
        timestamp: '1760000000',
        audio: { id: 'a77', mime_type: 'audio/ogg; codecs=opus', voice: true },
      }),
    )
    expect(messages).toMatchObject([
      { id: 'w5', type: 'audio', text: null, mediaId: 'a77', timestamp: 1760000000 },
    ])
  })

  it('keeps the message a reply answers', () => {
    const { messages } = parseWebhook(
      webhook({
        id: 'w6',
        from: '549',
        type: 'text',
        text: { body: 'sí' },
        context: { id: 'wamid.X' },
      }),
    )
    expect(messages[0]?.contextId).toBe('wamid.X')
  })

  it('keeps a photo whose image object is missing: the worker answers it, not the parser', () => {
    const { messages } = parseWebhook(webhook({ id: 'w4', from: '549', type: 'image' }))
    expect(messages).toMatchObject([{ id: 'w4', type: 'image', mediaId: null }])
  })

  it('skips a message that does not fit, and a body that is not a webhook', () => {
    expect(parseWebhook(webhook({ id: 5 })).messages).toEqual([])
    expect(parseWebhook('nope').messages).toEqual([])
  })

  it('reads status updates', () => {
    const { statuses } = parseWebhook({
      entry: [
        { changes: [{ value: { statuses: [{ id: 'o1', status: 'delivered', timestamp: '5' }] } }] },
      ],
    })
    expect(statuses).toMatchObject([{ id: 'o1', status: 'delivered', timestamp: 5 }])
  })
})
