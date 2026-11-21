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
    expect(messages).toMatchObject([{ id: 'w1', type: 'text', text: { body: 'café 3500' } }])
  })

  it('reads a photo: its media id, type and caption, never bytes', () => {
    const { messages } = parseWebhook(
      webhook({
        id: 'w2',
        from: '549',
        type: 'image',
        image: { id: '9988', mime_type: 'image/jpeg', sha256: 'abc', caption: 'anotá este ticket' },
      }),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.image).toEqual({
      id: '9988',
      mime_type: 'image/jpeg',
      caption: 'anotá este ticket',
    })
  })

  it('reads a photo with no caption, and keeps the raw message for the stored payload', () => {
    const raw = { id: 'w3', from: '549', type: 'image', image: { id: '1' } }
    const { messages } = parseWebhook(webhook(raw))
    expect(messages[0]?.image).toEqual({ id: '1' })
    expect(messages[0]?.raw).toEqual(raw)
  })

  it('keeps a photo whose image object is missing: the processor answers it, not the parser', () => {
    const { messages } = parseWebhook(webhook({ id: 'w4', from: '549', type: 'image' }))
    expect(messages).toMatchObject([{ id: 'w4', type: 'image' }])
    expect(messages[0]?.image).toBeUndefined()
  })

  it('skips a message that does not fit, and a body that is not a webhook', () => {
    expect(parseWebhook(webhook({ id: 5 })).messages).toEqual([])
    expect(parseWebhook('nope').messages).toEqual([])
  })
})
