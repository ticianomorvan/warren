import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bodies,
  fakeGraph,
  fakeTranscriber,
  gate,
  heard,
  logCall,
  messageBody,
  movement,
  OGG,
  photoBody,
  post,
  replyCall,
  row,
  script,
  seedMovements,
  setup,
  sql,
  until,
  useDatabase,
  voiceBody,
  WA,
} from '../test-harness'
import { TranscriptionError } from '../transcribe'
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MediaError } from './graph'
import { REPLY_AUDIO, REPLY_IMAGE, REPLY_NON_TEXT, REPLY_VOICE } from './replies'

useDatabase()

const RECEIPT = readFileSync(
  new URL('../../evals/scenarios/fixtures/receipt-farmacia.png', import.meta.url),
)
const GIF = Buffer.from('GIF89a..........')
const BIG_IMAGE = Buffer.concat([RECEIPT, Buffer.alloc(MAX_IMAGE_BYTES)])
/** An Ogg file that carries a marker, to look for in every table. */
const MARKER = 'warren-secret-audio-bytes'
const NOTE = Buffer.concat([OGG, Buffer.from(MARKER)])
const BIG_NOTE = Buffer.concat([OGG, Buffer.alloc(MAX_AUDIO_BYTES)])

const farmacia = movement({
  description: 'farmacia',
  amount: '8350',
  category: 'salud',
  payment: 'débito',
})

type App = Awaited<ReturnType<typeof setup>>

/** A photo in, waits until the message has left the worker. Returns the reply. */
async function photo(app: App, wamid: string, mediaId = 'm1', caption?: string, from = WA) {
  const before = app.calls.sent.length
  await post(app.base, photoBody(wamid, mediaId, caption, from))
  await until(async () =>
    ['done', 'failed', 'ignored'].includes(String((await row(wamid))?.status)),
  )
  return bodies(app.calls)[before] ?? ''
}

/** A voice note in, waits until the message has left the worker. Returns the reply. */
async function voice(app: App, wamid: string, mediaId = 'a1') {
  const before = app.calls.sent.length
  await post(app.base, voiceBody(wamid, mediaId, WA))
  await until(async () => ['done', 'failed'].includes(String((await row(wamid))?.status)))
  return bodies(app.calls)[before] ?? ''
}

/** No table holds any part of the media: not its bytes, not their base64. */
async function noBytesStored() {
  const everything = JSON.stringify(
    await Promise.all(
      ['wa_message', 'turn', 'movement', 'reply', 'account'].map((t) =>
        sql.unsafe(`SELECT t::text AS row FROM ${t} t`),
      ),
    ),
  )
  expect(everything).not.toContain(MARKER)
  expect(everything).not.toContain(RECEIPT.toString('base64').slice(0, 100))
  expect(everything).not.toContain('iVBORw0KGgo')
}

describe('a photo', () => {
  it('is downloaded and handed to the model as an image block, with its caption; the movement is logged', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: script(logCall(farmacia)) })
    expect(await photo(app, 'wamid.P1', 'm1', 'anotá este ticket')).toBe(
      '✓ Farmacia $8.350 (débito)',
    )
    expect(fake.calls.downloads).toEqual(['m1'])
    const first = app.requests[0]?.messages[0]?.content as unknown as {
      type: string
      [k: string]: unknown
    }[]
    expect(first.map((b) => b.type)).toEqual(['image', 'text'])
    expect(first[0]).toMatchObject({
      source: { type: 'base64', media_type: 'image/png', data: RECEIPT.toString('base64') },
    })
    expect(String(first[1]?.text)).toContain('<mensaje>\nanotá este ticket\n</mensaje>')
    app.close()
  })

  it('keeps the media id and the caption at ingest, and never the bytes', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: script(logCall(farmacia)) })
    await photo(app, 'wamid.P2', 'm1', 'anotá este ticket')
    expect(await row('wamid.P2')).toMatchObject({
      kind: 'image',
      text: 'anotá este ticket',
      media_id: 'm1',
    })
    await noBytesStored()
    app.close()
  })

  it('shows the typing indicator first: it goes out while the download is still going', async () => {
    const download = gate()
    const fake = fakeGraph({ media: { m1: RECEIPT }, download: () => download.promise })
    const app = await setup({ fake, model: script(logCall(farmacia)) })
    await post(app.base, photoBody('wamid.P3', 'm1', 'ticket', WA))
    await until(() => fake.calls.typing.length === 1)
    expect(fake.calls.downloads).toEqual(['m1']) // started, not finished
    expect(app.model.n).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    download.open()
    await until(() => app.calls.sent.length === 1)
    app.close()
  })

  it.each([
    ['is over 5 MB', BIG_IMAGE, 'too_large'],
    ['is not a JPEG, PNG or WebP', GIF, 'unsupported'],
  ] as const)(
    'that %s is answered with why, and the model is not called',
    async (_name, bytes, problem) => {
      const app = await setup({ fake: fakeGraph({ media: { m1: bytes } }) })
      expect(await photo(app, 'wamid.P4', 'm1', 'anotá')).toBe(REPLY_IMAGE[problem])
      expect(app.model.n).toBe(0)
      const stored = await row('wamid.P4')
      expect(stored?.status).toBe('done')
      expect(stored?.audit).toMatchObject([{ tool: 'notice', input: { media_id: 'm1' } }])
      expect(stored?.audit[0].detail).toContain(problem)
      const [t] = await sql`SELECT label, reply FROM turn`
      expect(t).toMatchObject({ label: 'notice', reply: REPLY_IMAGE[problem] })
      await noBytesStored()
      app.close()
    },
  )

  it('that cannot be downloaded, or has no media id, is answered too', async () => {
    const fake = fakeGraph({ media: { gone: new MediaError('unavailable', 'media download 410') } })
    const app = await setup({ fake })
    expect(await photo(app, 'wamid.P5', 'gone')).toBe(REPLY_IMAGE.unavailable)
    await post(app.base, messageBody('wamid.P6', WA, { type: 'image', text: undefined }))
    await until(async () => (await row('wamid.P6'))?.status === 'done')
    expect(bodies(app.calls).at(-1)).toBe(REPLY_IMAGE.unavailable)
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('from a sender who is not allowed is not downloaded at all', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, allowed: ['5491155550000'] })
    await photo(app, 'wamid.P7', 'm1', 'x', '5491100000000')
    expect(fake.calls.downloads).toEqual([])
    expect((await row('wamid.P7'))?.status).toBe('ignored')
    app.close()
  })

  it('is never taken for the answer to a question: a caption of "2" still goes to the model', async () => {
    const [a, b] = await seedMovements([
      { on: '2025-10-09', amount: '3500', description: 'café' },
      { on: '2025-10-09', amount: '12000', description: 'súper' },
    ])
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({
      fake,
      model: script(
        { name: 'ask_user', input: { movement_ids: [a, b], then: { do: 'delete' } } },
        replyCall('No te entendí'),
      ),
    })
    await post(app.base, messageBody('wamid.Q', WA, { text: { body: 'borrá uno' } }))
    await until(async () => (await row('wamid.Q'))?.status === 'done')
    await photo(app, 'wamid.P8', 'm1', '2')
    expect(app.model.n).toBe(2)
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(2)
    app.close()
  })

  it('shows in the conversation window of the next message, as a photo with its caption', async () => {
    const fake = fakeGraph({ media: { m1: RECEIPT } })
    const app = await setup({ fake, model: script(logCall(farmacia), replyCall('Hola')) })
    await photo(app, 'wamid.P9', 'm1', 'el ticket')
    await post(app.base, messageBody('wamid.P10', WA, { text: { body: 'hola' } }))
    await until(async () => (await row('wamid.P10'))?.status === 'done')
    expect(String(app.requests[1]?.messages[0]?.content)).toContain('[foto] el ticket')
    app.close()
  })
})

describe('a voice note', () => {
  it('is transcribed, stored as the message text, and answered with the usual record', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const stt = fakeTranscriber(heard('Anotá 4200 de farmacia'))
    const app = await setup({
      fake,
      transcriber: stt.transcriber,
      model: script(
        logCall(movement({ description: 'farmacia', amount: '4200', category: 'salud' })),
      ),
    })
    expect(await voice(app, 'wamid.A1')).toBe('✓ Farmacia $4.200 (visa)')
    expect(fake.calls.downloads).toEqual(['a1'])
    expect(stt.calls[0]?.audio).toMatchObject({ mediaType: 'audio/ogg', extension: 'ogg' })
    // The media id at ingest, the transcript at the commit point, never the audio.
    expect(await row('wamid.A1')).toMatchObject({
      kind: 'audio',
      media_id: 'a1',
      text: 'Anotá 4200 de farmacia',
    })
    await noBytesStored()
    // The model reads it as a transcript.
    const context = String(app.requests[0]?.messages[0]?.content)
    expect(context).toContain('<mensaje>\nAnotá 4200 de farmacia\n</mensaje>')
    expect(context).toContain('transcripción automática')
    app.close()
  })

  it('finds the older movement it names, as a typed message does (pre-search runs on what was heard)', async () => {
    // 12 newer movements push the alquiler out of the 10 newest.
    await seedMovements([
      { on: '2025-09-01', amount: '650000', description: 'alquiler' },
      ...Array.from({ length: 12 }, (_, k) => ({
        on: `2025-10-0${(k % 9) + 1}`,
        amount: String(1000 + k),
        description: `gasto${k}`,
      })),
    ])
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('borrá el alquiler')).transcriber,
      model: script({ name: 'help', input: {} }),
    })
    await voice(app, 'wamid.A9')
    const context = String(app.requests[0]?.messages[0]?.content)
    expect(context).toContain('alquiler')
    expect(context).toContain('Movimientos más antiguos que esa lista')
    app.close()
  })

  it('answers with what was heard when nothing changed, rendered by code', async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('hola que tal')).transcriber,
      model: script({ name: 'help', input: {} }),
    })
    expect((await voice(app, 'wamid.A2')).startsWith('🎙️ "hola que tal"\n')).toBe(true)
    app.close()
  })

  it('answering our question by voice goes to the model, never run by code on what was heard', async () => {
    const [a, b] = await seedMovements([
      { on: '2025-10-09', amount: '3500', description: 'café' },
      { on: '2025-10-09', amount: '12000', description: 'súper' },
    ])
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('el 2')).transcriber,
      model: script(
        { name: 'ask_user', input: { movement_ids: [a, b], then: { do: 'delete' } } },
        replyCall('Decime cuál'),
      ),
    })
    await post(app.base, messageBody('wamid.Q', WA, { text: { body: 'borrá uno' } }))
    await until(async () => (await row('wamid.Q'))?.status === 'done')
    await voice(app, 'wamid.A3')
    expect(app.model.n).toBe(2)
    expect(await sql`SELECT 1 FROM movement WHERE ended_at IS NULL`).toHaveLength(2)
    app.close()
  })

  it('shows the typing indicator first and starts the download beside the database reads', async () => {
    const download = gate()
    const fake = fakeGraph({ media: { a1: NOTE }, download: () => download.promise })
    const app = await setup({
      fake,
      transcriber: fakeTranscriber().transcriber,
      model: script(logCall(movement())),
    })
    await post(app.base, voiceBody('wamid.A4', 'a1', WA))
    await until(() => fake.calls.typing.length === 1)
    expect(fake.calls.downloads).toEqual(['a1'])
    expect(app.model.n).toBe(0)
    download.open()
    await until(() => app.calls.sent.length === 1)
    app.close()
  })

  it.each([
    ['noise the gate refuses', heard('gracias', { no_speech_prob: 0.9 }), REPLY_VOICE.unclear],
    ['a service that fails', new TranscriptionError('timeout', 'service down'), REPLY_VOICE.failed],
  ] as const)(
    'that is %s is answered with a notice, and the model is not called',
    async (_name, answer, notice) => {
      const app = await setup({
        fake: fakeGraph({ media: { a1: NOTE } }),
        transcriber: fakeTranscriber(answer).transcriber,
      })
      expect(await voice(app, 'wamid.A5')).toBe(notice)
      expect(app.model.n).toBe(0)
      const stored = await row('wamid.A5')
      expect(stored?.audit).toMatchObject([{ tool: 'notice', input: { media_id: 'a1' } }])
      // What the gate refused is not kept as something the person said.
      expect(stored?.text).toBeNull()
      await noBytesStored()
      app.close()
    },
  )

  it('that is too large, or cannot be downloaded, or has no media id, is answered too', async () => {
    const fake = fakeGraph({
      media: { big: BIG_NOTE, gone: new MediaError('unavailable', 'media download 410') },
    })
    const app = await setup({ fake, transcriber: fakeTranscriber().transcriber })
    expect(await voice(app, 'wamid.A6', 'big')).toBe(REPLY_VOICE.too_large)
    expect(await voice(app, 'wamid.A7', 'gone')).toBe(REPLY_VOICE.failed)
    await post(app.base, messageBody('wamid.A8', WA, { type: 'audio', text: undefined }))
    await until(async () => (await row('wamid.A8'))?.status === 'done')
    expect(bodies(app.calls).at(-1)).toBe(REPLY_VOICE.failed)
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('past the message deadline while transcribing fails the message, and stops the call', async () => {
    let signal: AbortSignal | undefined
    const stt = fakeTranscriber(async (s) => {
      signal = s
      await new Promise((resolve) => s?.addEventListener('abort', resolve))
      throw new DOMException('aborted', 'AbortError')
    })
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: stt.transcriber,
      deadlineMs: 150,
    })
    await post(app.base, voiceBody('wamid.A9', 'a1', WA))
    await until(async () => (await row('wamid.A9'))?.status === 'failed')
    expect(signal?.aborted).toBe(true)
    expect(app.model.n).toBe(0)
    app.close()
  })

  it('from a sender who is not allowed is neither downloaded nor transcribed', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const stt = fakeTranscriber()
    const app = await setup({ fake, transcriber: stt.transcriber, allowed: ['5491155550000'] })
    await post(app.base, voiceBody('wamid.A10', 'a1', WA))
    await until(async () => (await row('wamid.A10'))?.status === 'ignored')
    expect(fake.calls.downloads).toEqual([])
    expect(stt.calls).toHaveLength(0)
    app.close()
  })

  it('is still answered with a request for text when no transcription service is configured', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const app = await setup({ fake })
    await post(app.base, voiceBody('wamid.A11', 'a1', WA))
    await until(async () => (await row('wamid.A11'))?.status === 'done')
    expect(bodies(app.calls)).toEqual([REPLY_AUDIO])
    expect(fake.calls.downloads).toEqual([])
    expect(app.model.n).toBe(0)
    app.close()
  })
})

describe('what is not text, a photo or a voice note', () => {
  it('any other kind gets the short reply, with no model call and no download', async () => {
    const fake = fakeGraph()
    const app = await setup({ fake })
    await post(app.base, messageBody('wamid.S1', WA, { type: 'sticker', text: undefined }))
    await until(async () => (await row('wamid.S1'))?.status === 'done')
    expect(bodies(app.calls)).toEqual([REPLY_NON_TEXT])
    expect(fake.calls.downloads).toEqual([])
    app.close()
  })
})
