import { describe, expect, it } from 'vitest'
import {
  ask,
  correct,
  live,
  logOf,
  movement,
  remove,
  replyCall,
  say,
  script,
  seed,
  WA,
} from './command-fixtures'
import {
  REPLY_AUDIO,
  REPLY_FAILED,
  REPLY_GONE,
  REPLY_INTERIM,
  REPLY_SAY_FALLBACK,
  REPLY_VOICE,
} from './render'
import {
  bodies,
  fakeGraph,
  fakeModel,
  fakeTranscriber,
  gate,
  heard,
  OGG,
  post,
  row,
  setup,
  sql,
  until,
  useDatabase,
  voiceBody,
} from './test-harness'
import { TranscriptionError } from './transcribe'
import { MAX_AUDIO_BYTES, MediaError } from './whatsapp/graph'

useDatabase()

/** An Ogg file that carries a marker, to look for in every table. */
const MARKER = 'warren-secret-audio-bytes'
const NOTE = Buffer.concat([OGG, Buffer.from(MARKER)])
const BIG = Buffer.concat([OGG, Buffer.alloc(MAX_AUDIO_BYTES)])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])
const AAC = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]) // raw ADTS AAC: the service refuses it

const farmacia = movement({ description: 'farmacia', amount: '4200', category: 'salud' })

/** A voice note in, waits until the message has left the processor. Returns the reply. */
async function voice(app: Awaited<ReturnType<typeof setup>>, wamid: string, mediaId = 'a1') {
  const before = app.calls.sent.length
  await post(app.base, voiceBody(wamid, mediaId, WA))
  await until(async () => ['done', 'failed'].includes(String((await row(wamid))?.status)))
  return bodies(app.calls)[before] ?? ''
}

/** Nothing of the audio is in any table: not its bytes, not their base64. */
async function noAudioStored() {
  const everything = JSON.stringify(
    await Promise.all(
      ['inbound_message', 'movement', 'reply', 'account'].map((t) =>
        sql.unsafe(`SELECT t::text AS row FROM ${t} t`),
      ),
    ),
  )
  expect(everything).not.toContain(MARKER)
  expect(everything).not.toContain(NOTE.toString('base64').slice(8))
}

describe('a voice note', () => {
  it('is transcribed, and the reply is the usual one: the record shows what was understood, no 🎙️ line', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const stt = fakeTranscriber(heard('Anotá 4200 de farmacia'))
    const app = await setup({ fake, transcriber: stt.transcriber, model: script(logOf(farmacia)) })
    const reply = await voice(app, 'wamid.A1')
    expect(reply).toBe('✓ Farmacia $4.200')
    expect(await live()).toEqual(['farmacia 4200'])
    expect(fake.calls.downloads).toEqual(['a1'])
    expect(stt.calls).toHaveLength(1)
    expect(stt.calls[0]?.audio).toMatchObject({ mediaType: 'audio/ogg', extension: 'ogg' })
    app.close()
  })

  it("is the person's message for the model, marked as a transcript", async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('Anotá 4200 de farmacia')).transcriber,
      model: script(logOf(farmacia)),
    })
    await voice(app, 'wamid.A2')
    const context = String(app.requests[0]?.messages[0]?.content)
    expect(context).toContain('<mensaje>\nAnotá 4200 de farmacia\n</mensaje>')
    expect(context).toContain('nota de voz')
    expect(context).toContain('transcripción automática')
    app.close()
  })

  it.each([
    [
      'a summary',
      () =>
        script({
          name: 'summarize',
          input: {
            range: { period: 'this_month', month: 0, year: 0, from: '', to: '' },
            group_by: 'none',
            compare_to: 'none',
            other: '',
            direction: 'out',
            category: null,
            payment: null,
            description: null,
            text: null,
          },
        }),
      /^🎙️ "¿cuánto voy\?"\nOctubre \(1–9, en curso\) gastaste/,
    ],
    ['a question', () => script(ask([1, 2], { after: 'none' })), /^🎙️ "¿cuánto voy\?"\n¿Cuál\?/],
    [
      "the model's own words",
      () => script(replyCall('Gastaste lo de siempre.')),
      /^🎙️ "¿cuánto voy\?"\nGastaste lo de siempre\.$/,
    ],
  ])(
    'starts the reply with what was heard when the answer is %s (no record of a change)',
    async (_what, model, expected) => {
      await seed([
        { on: '2025-10-09', amount: '3500', description: 'café', at: '10:10' },
        { on: '2025-10-09', amount: '2900', description: 'café', at: '11:54' },
      ])
      const app = await setup({
        fake: fakeGraph({ media: { a1: NOTE } }),
        transcriber: fakeTranscriber(heard('¿cuánto voy?')).transcriber,
        model: model(),
      })
      expect(await voice(app, 'wamid.H1')).toMatch(expected)
      app.close()
    },
  )

  it.each([
    [
      'a correction',
      (id: number) => correct(id, { amount: '3800' }),
      '✓ Corregido: Café $3.800 (antes $3.500)',
    ],
    ['a deletion', (id: number) => remove(id), '✓ Borré: Café $3.500'],
  ])(
    'leaves the line out when the voice note made %s: the record shows what was understood',
    async (_what, call, line) => {
      const [id] = await seed([
        { on: '2025-10-09', amount: '3500', description: 'café', at: '10:10' },
      ])
      const app = await setup({
        fake: fakeGraph({ media: { a1: NOTE } }),
        transcriber: fakeTranscriber(heard('no, el café')).transcriber,
        model: script(call(id ?? 0)),
      })
      const reply = await voice(app, 'wamid.H2')
      expect(reply).toContain(line)
      expect(reply).not.toContain('🎙️')
      app.close()
    },
  )

  it('shows the line when the change did not apply (it was already gone): no record shows what was understood', async () => {
    const [id] = await seed([
      { on: '2025-10-09', amount: '3500', description: 'café', at: '10:10' },
    ])
    const slow = gate()
    let conversation = 0
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(async () => {
        await slow.promise
        return heard('borrá el café')
      }).transcriber,
      model: script(remove(id ?? 0)),
      processorStore: (store) => ({
        ...store,
        conversation: (c) => {
          conversation++
          return store.conversation(c)
        },
      }),
    })
    await post(app.base, voiceBody('wamid.H4', 'a1', WA))
    await until(() => conversation === 1) // the list was read: the café is in it
    await sql`UPDATE movement SET deleted_at = now(), deleted_by = (SELECT id FROM inbound_message WHERE wamid = 'wamid.H4') WHERE id = ${id ?? 0}` // another message deleted it meanwhile
    slow.open()
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)[0]).toBe(`🎙️ "borrá el café"\n${REPLY_GONE}`)
    app.close()
  })

  it('cuts what was heard at 80 characters with "…"', async () => {
    const long = `¿cuánto voy ${'gastado '.repeat(30)}?`.trim()
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard(long)).transcriber,
      model: script(replyCall('Gastaste lo de siempre.')),
    })
    const first = (await voice(app, 'wamid.H5')).split('\n')[0] ?? ''
    expect(first.startsWith('🎙️ "¿cuánto voy gastado')).toBe(true)
    expect(first.endsWith('…"')).toBe(true)
    expect(first.length).toBeLessThanOrEqual('🎙️ ""'.length + 80)
    // the whole transcript is still the message, and stored
    expect((await row('wamid.H5'))?.body).toBe(long)
    app.close()
  })

  it('keeps the media id and the transcript, and never the audio', async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('Anotá 4200 de farmacia')).transcriber,
      model: script(logOf(farmacia)),
    })
    await voice(app, 'wamid.A3')
    const stored = await row('wamid.A3')
    expect(stored).toMatchObject({ kind: 'audio', body: 'Anotá 4200 de farmacia' })
    expect(stored?.payload.audio).toMatchObject({ id: 'a1' })
    await noAudioStored()
    app.close()
  })

  it('shows the typing indicator first: it goes out while the download is still going', async () => {
    const download = gate()
    const fake = fakeGraph({ media: { a1: NOTE }, download: () => download.promise })
    const stt = fakeTranscriber(heard('Anotá 4200 de farmacia'))
    const app = await setup({ fake, transcriber: stt.transcriber, model: script(logOf(farmacia)) })
    await post(app.base, voiceBody('wamid.A4', 'a1', WA))
    await until(() => fake.calls.typing.length === 1)
    expect(fake.calls.downloads).toEqual(['a1'])
    expect(stt.calls).toHaveLength(0)
    expect(app.model.n).toBe(0)
    expect(app.calls.sent).toHaveLength(0)
    download.open()
    await until(() => app.calls.sent.length === 1)
    app.close()
  })

  it('reads the database while the transcription is still running, not after it', async () => {
    const slow = gate()
    let conversation = 0
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(async () => {
        await slow.promise
        return heard('Anotá 4200 de farmacia')
      }).transcriber,
      model: script(logOf(farmacia)),
      processorStore: (store) => ({
        ...store,
        conversation: (c) => {
          conversation++
          return store.conversation(c)
        },
      }),
    })
    await post(app.base, voiceBody('wamid.A11', 'a1', WA))
    await until(() => conversation === 1) // read while the transcription has not answered
    expect(app.calls.sent).toHaveLength(0)
    slow.open()
    await until(() => app.calls.sent.length === 1)
    app.close()
  })

  it('keeps the whole reply under what WhatsApp accepts, for the longest note and the largest log', async () => {
    const long = 'palabra '.repeat(124).trim() // 991 characters: just under the gate
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard(long)).transcriber,
      model: script(
        logOf(
          ...Array.from({ length: 10 }, (_, k) =>
            movement({
              description: `compra número ${k + 1} de nombre largo`,
              amount: String(1000 + k),
            }),
          ),
        ),
      ),
    })
    const reply = await voice(app, 'wamid.A12')
    expect(reply.length).toBeLessThanOrEqual(4096)
    expect(reply).toContain('✓ Anoté 10:')
    expect(await live()).toHaveLength(10)
    app.close()
  })

  it('shows in the conversation window of the next message as [audio] and what was heard', async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('Anotá 4200 de farmacia')).transcriber,
      model: fakeModel(() => [logOf(farmacia)]),
    })
    await voice(app, 'wamid.A5')
    await say(app, { text: 'gracias' })
    const context = String(app.requests.at(-1)?.messages[0]?.content)
    expect(context).toContain('(persona, hace 0 min) [audio] Anotá 4200 de farmacia')
    expect(context).toContain('(Warren) ✓ Farmacia $4.200')
    app.close()
  })

  it("counts as what the person said for the numbers check of the model's own words", async () => {
    // The 4200 is theirs, so the model may repeat it.
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('¿te dije 4200 recién?')).transcriber,
      model: script(replyCall('Sí, me dijiste 4200.')),
    })
    expect(await voice(app, 'wamid.A6')).toBe('🎙️ "¿te dije 4200 recién?"\nSí, me dijiste 4200.')
    app.close()
  })

  it('does not make a number up for the model: the same words about a number nobody said are dropped', async () => {
    const said = replyCall('Sí, me dijiste 4200.')
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('¿te dije algo recién?')).transcriber,
      model: script(said, said, said),
    })
    expect(await voice(app, 'wamid.A7')).toBe(`🎙️ "¿te dije algo recién?"\n${REPLY_SAY_FALLBACK}`)
    app.close()
  })

  it('answering our question by voice goes to the model, never run by code on what was heard', async () => {
    await seed([
      { on: '2025-10-09', amount: '3500', description: 'café', at: '10:10' },
      { on: '2025-10-09', amount: '2900', description: 'café', at: '11:54' },
    ])
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('El segundo')).transcriber,
      model: script(ask([2, 1], { after: 'delete' }), logOf(farmacia)),
    })
    await say(app, { text: 'borra el cafe' })
    await voice(app, 'wamid.A8')
    expect(app.model.n).toBe(2)
    expect(await live()).toContain('farmacia 4200')
    expect(await live()).toContain('café 3500')
    app.close()
  })

  it('from a sender who is not allowed is neither downloaded nor transcribed', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const stt = fakeTranscriber()
    const app = await setup({ fake, transcriber: stt.transcriber, allowed: ['5491155550000'] })
    await post(app.base, voiceBody('wamid.A9', 'a1', WA))
    await until(async () => (await row('wamid.A9'))?.status === 'ignored')
    expect(fake.calls.downloads).toEqual([])
    expect(stt.calls).toHaveLength(0)
    app.close()
  })

  it('is still answered with a request for text when no transcription service is configured', async () => {
    const fake = fakeGraph({ media: { a1: NOTE } })
    const app = await setup({ fake })
    expect(await voice(app, 'wamid.A10')).toBe(REPLY_AUDIO)
    expect(fake.calls.downloads).toEqual([])
    app.close()
  })
})

describe('a voice note that the confidence gate refuses', () => {
  it.each([
    ['punctuation only', heard('.', { avg_logprob: -1.91 })],
    ['unsure', heard('Chika', { avg_logprob: -0.59 })],
    [
      'a loop of one sound',
      heard('Chika-chika, chika-chika', { avg_logprob: -0.2, compression_ratio: 2.1 }),
    ],
    ['not speech', heard('Gracias', { no_speech_prob: 0.16 })],
    ['empty', heard('')],
  ])(
    '(%s) is answered with a code notice: no model call, nothing logged',
    async (_why, transcript) => {
      const app = await setup({
        fake: fakeGraph({ media: { a1: NOTE } }),
        transcriber: fakeTranscriber(transcript).transcriber,
      })
      expect(await voice(app, 'wamid.G1')).toBe('No te entendí el audio, ¿me lo escribís?')
      expect(REPLY_VOICE.unclear).toBe('No te entendí el audio, ¿me lo escribís?')
      expect(app.model.n).toBe(0)
      expect(await live()).toEqual([])
      const stored = await row('wamid.G1')
      expect(stored).toMatchObject({ status: 'done', action: 'reply', body: null })
      expect(stored?.tool_calls).toMatchObject([{ tool: 'notice', input: { media_id: 'a1' } }])
      expect(stored?.tool_calls[0].detail).toMatch(/refused/)
      await noAudioStored()
      app.close()
    },
  )

  it('that is too long to be a note about an expense gets the "too long" notice, not "no te entendí"', async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('café '.repeat(300))).transcriber,
    })
    expect(await voice(app, 'wamid.G3')).toBe(REPLY_VOICE.too_large)
    expect(app.model.n).toBe(0)
    expect(await live()).toEqual([])
    app.close()
  })

  it("does not put the refused noise in the next message's window as something the person said", async () => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(heard('Chika', { avg_logprob: -0.59 })).transcriber,
      model: fakeModel(() => [logOf(farmacia)]),
    })
    await voice(app, 'wamid.G2')
    await say(app, { text: 'farmacia 4200' })
    const context = String(app.requests.at(-1)?.messages[0]?.content)
    expect(context).toContain('[audio]')
    expect(context).not.toContain('Chika')
    app.close()
  })
})

describe('a voice note that cannot be used', () => {
  it.each([
    ['is too big', BIG, REPLY_VOICE.too_large],
    ['is not Ogg, MP4 or MP3', PNG, REPLY_VOICE.unsupported],
    ['is raw AAC, which the service does not read', AAC, REPLY_VOICE.unsupported],
  ])('that %s is answered with why, and nothing is transcribed', async (_name, bytes, notice) => {
    const stt = fakeTranscriber()
    const app = await setup({
      fake: fakeGraph({ media: { a1: bytes } }),
      transcriber: stt.transcriber,
    })
    expect(await voice(app, 'wamid.U1')).toBe(notice)
    expect(stt.calls).toHaveLength(0)
    expect(app.model.n).toBe(0)
    expect(await live()).toEqual([])
    app.close()
  })

  it('that cannot be downloaded, or has no media id, is answered too', async () => {
    const fake = fakeGraph({ media: { gone: new MediaError('unavailable', 'media download 410') } })
    const app = await setup({ fake, transcriber: fakeTranscriber().transcriber })
    expect(await voice(app, 'wamid.U2', 'gone')).toBe(REPLY_VOICE.failed)
    expect(await voice(app, 'wamid.U3', 'never-stored')).toBe(REPLY_VOICE.failed)
    app.close()
  })

  it.each([
    ['the service fails', new TranscriptionError('service', 'HTTP 503')],
    ['the service is too slow', new TranscriptionError('timeout', 'no answer in 10000 ms')],
    ['the service answers nonsense', new TranscriptionError('bad_response', 'no text')],
  ])('when %s, the person gets a clear notice and the cause is kept', async (_why, error) => {
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: fakeTranscriber(error).transcriber,
    })
    expect(await voice(app, 'wamid.F1')).toBe('No pude procesar el audio, ¿me lo escribís?')
    expect(app.model.n).toBe(0)
    const stored = await row('wamid.F1')
    expect(stored).toMatchObject({ status: 'done', action: 'reply' })
    expect(stored?.tool_calls[0].detail).toContain(error.failure)
    app.close()
  })

  it('past the message deadline while transcribing fails the message with the failure notice, and stops the call', async () => {
    let given: AbortSignal | undefined
    const stt = fakeTranscriber(
      (signal) =>
        new Promise((_resolve, reject) => {
          given = signal
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: stt.transcriber,
      deadlineMs: 150,
    })
    expect(await voice(app, 'wamid.F2')).toBe(REPLY_FAILED)
    expect((await row('wamid.F2'))?.status).toBe('failed')
    expect(app.model.n).toBe(0)
    expect(given?.aborted).toBe(true) // the call was cancelled, not left running
    app.close()
  })

  it('past the message deadline while downloading fails the message too, and stops the download', async () => {
    const never = gate()
    const fake = fakeGraph({ media: { a1: NOTE }, download: () => never.promise })
    const app = await setup({
      fake,
      transcriber: fakeTranscriber().transcriber,
      deadlineMs: 150,
    })
    expect(await voice(app, 'wamid.F4')).toBe(REPLY_FAILED)
    expect(fake.calls.signals[0]?.aborted).toBe(true)
    app.close()
  })

  it('that is slow gets the interim note, then its reply, like any message', async () => {
    const slow = gate()
    const stt = fakeTranscriber(async () => {
      await slow.promise
      return heard('Anotá 4200 de farmacia')
    })
    const app = await setup({
      fake: fakeGraph({ media: { a1: NOTE } }),
      transcriber: stt.transcriber,
      model: script(logOf(farmacia)),
      interimMs: 30,
    })
    await post(app.base, voiceBody('wamid.F3', 'a1', WA))
    await until(() => app.calls.sent.length === 1)
    expect(bodies(app.calls)).toEqual([REPLY_INTERIM])
    slow.open()
    await until(() => app.calls.sent.length === 2)
    expect(bodies(app.calls)[1]).toBe('✓ Farmacia $4.200')
    app.close()
  })
})
