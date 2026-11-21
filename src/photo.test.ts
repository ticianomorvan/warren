import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ask, live, logOf, movement, say, script, seed, WA } from './command-fixtures'
import { REPLY_AUDIO, REPLY_IMAGE, REPLY_NON_TEXT } from './render'
import {
  bodies,
  fakeGraph,
  fakeModel,
  gate,
  messageBody,
  photoBody,
  post,
  row,
  setup,
  sql,
  until,
  useDatabase,
} from './test-harness'
import { MAX_IMAGE_BYTES, MediaError } from './whatsapp/graph'

useDatabase()

const RECEIPT = readFileSync(
  new URL('../evals/scenarios/fixtures/receipt-farmacia.png', import.meta.url),
)
const GIF = Buffer.from('GIF89a..........')
const BIG = Buffer.concat([RECEIPT, Buffer.alloc(MAX_IMAGE_BYTES)])

const farmacia = movement({
  description: 'farmacia',
  amount: '8350',
  category: 'salud',
  payment: 'débito',
})

/** A photo in, waits until the message has left the processor. */
async function photo(
  app: Awaited<ReturnType<typeof setup>>,
  wamid: string,
  mediaId = 'm1',
  caption?: string,
) {
  const before = app.calls.sent.length
  await post(app.base, photoBody(wamid, mediaId, caption, WA))
  await until(async () => ['done', 'failed'].includes(String((await row(wamid))?.status)))
  return bodies(app.calls)[before] ?? ''
}

/** No table holds any part of the image: not the base64, and not the PNG's own first bytes in base64. */
async function noBytesStored() {
  const everything = JSON.stringify(
    await Promise.all(
      ['inbound_message', 'movement', 'reply', 'account'].map((t) =>
        sql.unsafe(`SELECT t::text AS row FROM ${t} t`),
      ),
    ),
  )
  expect(everything).not.toContain(RECEIPT.toString('base64').slice(0, 100))
  expect(everything).not.toContain('iVBORw0KGgo')
}

describe('a photo', () => {
  it('is downloaded and handed to the model as an image block, with its caption; the movement is logged', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: script(logOf(farmacia)) })
    const reply = await photo(app, 'wamid.P1', 'm1', 'anotá este ticket')
    expect(reply).toBe('✓ Farmacia $8.350 (débito)')
    expect(await live()).toEqual(['farmacia 8350'])
    expect(fake.calls.downloads).toEqual(['m1'])

    const first = app.requests[0]?.messages[0]?.content as unknown as {
      type: string
      [k: string]: unknown
    }[]
    expect(first.map((b) => b.type)).toEqual(['image', 'text'])
    expect(first[0]).toMatchObject({
      source: { type: 'base64', media_type: 'image/png', data: RECEIPT.toString('base64') },
    })
    expect(String(first[1]?.text)).toContain('La persona envió una foto')
    expect(String(first[1]?.text)).toContain('<mensaje>\nanotá este ticket\n</mensaje>')
    app.close()
  })

  it('keeps the media id and the caption, and never the bytes', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: script(logOf(farmacia)) })
    await photo(app, 'wamid.P2', 'm1', 'anotá este ticket')
    const stored = await row('wamid.P2')
    expect(stored).toMatchObject({ kind: 'image', body: 'anotá este ticket' })
    expect(stored?.payload.image).toMatchObject({ id: 'm1', caption: 'anotá este ticket' })
    await noBytesStored()
    app.close()
  })

  it('shows the typing indicator first: it goes out while the download is still going', async () => {
    const download = gate()
    const fake = fakeGraph({ media: { m1: RECEIPT }, download: () => download.promise })
    const app = await setup({ fake, model: script(logOf(farmacia)) })
    await post(app.base, photoBody('wamid.P3', 'm1', 'ticket', WA))
    await until(() => fake.calls.typing.length === 1)
    expect(fake.calls.downloads).toEqual(['m1']) // started, not finished
    expect(app.model.n).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    download.open()
    await until(() => app.calls.sent.length === 1)
    expect(fake.calls.typing).toEqual(['wamid.P3'])
    app.close()
  })

  it.each([
    ['is over 5 MB', BIG, 'too_large'],
    ['is not a JPEG, PNG or WebP', GIF, 'unsupported'],
  ] as const)(
    'that %s is answered with why, and the model is not called',
    async (_name, bytes, problem) => {
      const fake = fakeGraph({ media: { m1: bytes } })
      const app = await setup({ fake })
      expect(await photo(app, 'wamid.P4', 'm1', 'anotá')).toBe(REPLY_IMAGE[problem])
      expect(app.model.n).toBe(0)
      expect(await live()).toEqual([])
      const stored = await row('wamid.P4')
      expect(stored).toMatchObject({
        status: 'done',
        action: 'reply',
        reply_text: REPLY_IMAGE[problem],
      })
      expect(stored?.tool_calls).toMatchObject([{ tool: 'notice', input: { media_id: 'm1' } }])
      expect(stored?.tool_calls[0].detail).toContain(problem)
      await noBytesStored()
      app.close()
    },
  )

  it('that cannot be downloaded, or has no media id, is answered too', async () => {
    const fake = fakeGraph({ media: { gone: new MediaError('unavailable', 'media download 410') } })
    const app = await setup({ fake })
    expect(await photo(app, 'wamid.P5', 'gone')).toBe(REPLY_IMAGE.unavailable)
    expect(await photo(app, 'wamid.P6', 'never-stored')).toBe(REPLY_IMAGE.unavailable)
    // a webhook with no image object at all
    await post(app.base, messageBody('wamid.P7', WA, { type: 'image', text: undefined }))
    await until(async () => (await row('wamid.P7'))?.status === 'done')
    expect(bodies(app.calls).at(-1)).toBe(REPLY_IMAGE.unavailable)
    expect(fake.calls.downloads).toEqual(['gone', 'never-stored'])
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('from a sender who is not allowed is not downloaded at all', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, allowed: ['5491155550000'] })
    await post(app.base, photoBody('wamid.P8', 'm1', 'x', WA))
    await until(async () => (await row('wamid.P8'))?.status === 'ignored')
    expect(fake.calls.downloads).toEqual([])
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('is never taken for the answer to a question: a caption of "2" still goes to the model', async () => {
    await seed([
      { on: '2025-10-09', amount: '3500', description: 'café', at: '10:10' },
      { on: '2025-10-09', amount: '2900', description: 'café', at: '11:54' },
    ])
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({
      fake,
      model: script(ask([2, 1], { after: 'delete' }), logOf(farmacia)),
    })
    await say(app, { text: 'borra el cafe' })
    await photo(app, 'wamid.P9', 'm1', '2')
    expect(app.model.n).toBe(2)
    expect(await live()).toContain('farmacia 8350')
    app.close()
  })

  it('shows in the conversation window of the next message, as a photo with its caption', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: fakeModel(() => [logOf(farmacia)]) })
    await photo(app, 'wamid.P10', 'm1', 'anotá este ticket')
    await say(app, { text: 'gracias' })
    const context = String(app.requests.at(-1)?.messages[0]?.content)
    expect(context).toContain('(persona, hace 0 min) [foto] anotá este ticket')
    expect(context).toContain('(Warren) ✓ Farmacia $8.350 (débito)')
    app.close()
  })
})

describe('what is not text or a photo', () => {
  it('asks for text when it is a voice note, with no model call and no download', async () => {
    const fake = fakeGraph()
    const app = await setup({ fake })
    await post(
      app.base,
      messageBody('wamid.V1', WA, {
        type: 'audio',
        text: undefined,
        audio: { id: 'a1', voice: true },
      }),
    )
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_AUDIO])
    expect(REPLY_AUDIO).toContain('Escribime')
    expect(fake.calls.downloads).toEqual([])
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('answers any other kind with the short reply', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.V2', WA, { type: 'sticker', text: undefined }))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_NON_TEXT])
    app.close()
  })
})
