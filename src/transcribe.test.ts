import { describe, expect, it } from 'vitest'
import {
  createTranscriber,
  judgeTranscript,
  PROVIDER_PIN,
  type Segment,
  TRANSCRIPTION_MODEL,
  TranscriptionError,
  VOCABULARY_PROMPT,
} from './transcribe'
import { checkAudio } from './whatsapp/graph'

const seg = (o: Partial<Segment> = {}): Segment => ({
  start: 0,
  end: 4,
  avg_logprob: -0.2,
  compression_ratio: 1,
  no_speech_prob: 0.005,
  ...o,
})
const note = (text: string, ...segments: Partial<Segment>[]) => ({
  text,
  segments: (segments.length > 0 ? segments : [{}]).map(seg),
})

describe('the confidence gate', () => {
  // Ticiano's real notes, measured 2026-11-21 (transcripts only; the audio is not in the repository).
  it.each([
    ['Gasté 3.500 en café, 8.000 en el súper y 10.000 con la visa en el YPF.', -0.18, 1.06, 0.003],
    ['No, en YPF fueron 10.500.', -0.23, 0.76, 0.002],
    ['¿Cuánto va este mes, más o menos?', -0.25, 0.84, 0.008],
  ])('passes the good note "%s"', (text, avg_logprob, compression_ratio, no_speech_prob) => {
    expect(
      judgeTranscript(note(` ${text}`, { avg_logprob, compression_ratio, no_speech_prob })),
    ).toEqual({ ok: true, text })
  })

  // The beatbox note, which Whisper turned into words in different ways on different draws.
  it.each([
    ['.', -1.91, 0.2, 0.16, 'empty'],
    ['Chika-chika, chika-chika', -0.59, 1.14, 0.16, 'low_confidence'],
    ['Chika, chika, chika chika, chika, chika, chika.', -0.49, 2.09, 0.16, 'low_confidence'],
    ['Chika-chika, chika-chika, chika-chika, chika-chika.', -0.18, 2.26, 0.16, 'repetitive'],
    ['Chicachi, chicachi, chicachi, chicachi.', -0.41, 1.74, 0.16, 'low_confidence'],
    ['¡Hola!', -0.46, 0.5, 0.16, 'low_confidence'],
    ['Subtitulado por Cienciapiezo.', -1.47, 0.79, 0.16, 'low_confidence'],
    ['Shk tch-shk-tsch-shk', -1.82, 0.88, 0.16, 'low_confidence'],
  ])('refuses the noise "%s"', (text, avg_logprob, compression_ratio, no_speech_prob, reason) => {
    const verdict = judgeTranscript(note(text, { avg_logprob, compression_ratio, no_speech_prob }))
    expect(verdict).toMatchObject({ ok: false, reason })
  })

  it('refuses a loop of one sound even when the model was sure of every sound', () => {
    expect(
      judgeTranscript(note('Chica, chica, chica', { avg_logprob: -0.1, compression_ratio: 2.1 })),
    ).toMatchObject({
      ok: false,
      reason: 'repetitive',
    })
  })

  it('refuses silence that Whisper filled with words, whatever its confidence', () => {
    expect(
      judgeTranscript(note('Gracias por ver el video', { no_speech_prob: 0.16 })),
    ).toMatchObject({
      ok: false,
      reason: 'no_speech',
    })
  })

  it('refuses an empty text, one with no letter or digit, and a note with no segments', () => {
    for (const text of ['', '   ', '.', '¿?', '...!', '—']) {
      expect(judgeTranscript(note(text)), text).toMatchObject({ ok: false, reason: 'empty' })
    }
    expect(judgeTranscript({ text: 'hola', segments: [] })).toMatchObject({
      ok: false,
      reason: 'empty',
    })
  })

  it('lets a short number through: a digit is enough to be a message', () => {
    expect(judgeTranscript(note('3500'))).toEqual({ ok: true, text: '3500' })
  })

  it('refuses one mumbled stretch inside a long, clear note', () => {
    const verdict = judgeTranscript(
      note(
        'Café 3500, mmm, y súper 12.000',
        { end: 20 },
        { start: 20, end: 22, avg_logprob: -1.3 },
      ),
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'low_confidence' })
  })

  it('weighs the segments by how long they are', () => {
    // A 1 s stretch at -0.9 beside 9 s at -0.2 averages -0.27: fine.
    const verdict = judgeTranscript(
      note('Café 3500 y súper 12.000', { end: 9 }, { start: 9, end: 10, avg_logprob: -0.9 }),
    )
    expect(verdict.ok).toBe(true)
  })

  it('refuses a text too long to be a note about an expense', () => {
    const verdict = judgeTranscript(note('x'.repeat(3001)))
    expect(verdict).toMatchObject({ ok: false, reason: 'too_long' })
  })

  it('collapses the whitespace of the transcript into one line', () => {
    expect(judgeTranscript(note('  café\n3500   y\tsúper  '))).toEqual({
      ok: true,
      text: 'café 3500 y súper',
    })
  })
})

describe('createTranscriber', () => {
  const OGG = checkAudio(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]))
  const GOOD = JSON.stringify({
    text: ' café 3500',
    segments: [
      { id: 0, start: 0, end: 2, avg_logprob: -0.2, compression_ratio: 1, no_speech_prob: 0.01 },
    ],
  })

  /** A fetch that records the request and answers `reply`. */
  function fetchWith(reply: () => Response | Promise<Response>) {
    const seen: { url: string; init: RequestInit; form: FormData }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init, form: init.body as FormData })
      return reply()
    }) as unknown as typeof fetch
    return { fetchFn, seen }
  }

  it('posts the note to OpenRouter pinned to Groq, with the language, the vocabulary and the key', async () => {
    const { fetchFn, seen } = fetchWith(() => new Response(GOOD))
    const t = createTranscriber({ apiKey: 'sk-test', fetch: fetchFn })
    await expect(t.transcribe(OGG)).resolves.toMatchObject({ text: ' café 3500' })
    const [call] = seen
    expect(call?.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(call?.init.method).toBe('POST')
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer sk-test')
    const form = call?.form
    expect(form?.get('model')).toBe('openai/whisper-large-v3')
    expect(TRANSCRIPTION_MODEL).toBe('openai/whisper-large-v3')
    expect(form?.get('language')).toBe('es')
    expect(form?.get('temperature')).toBe('0')
    expect(form?.get('response_format')).toBe('verbose_json')
    expect(form?.get('prompt')).toBe(VOCABULARY_PROMPT)
    // The pin: unpinned, OpenRouter routes to DeepInfra, which heard "YPF" as "IPEF".
    expect(JSON.parse(String(form?.get('provider')))).toEqual({
      order: ['groq'],
      allow_fallbacks: false,
    })
    expect(PROVIDER_PIN).toEqual({ order: ['groq'], allow_fallbacks: false })
    const file = form?.get('file') as File
    expect(file.name).toBe('voice.ogg')
    expect(file.type).toBe('audio/ogg')
    expect(file.size).toBe(7)
  })

  it('keeps the vocabulary inside what Groq reads (224 tokens) and names what fixed YPF', () => {
    expect(VOCABULARY_PROMPT).toContain('YPF')
    expect(VOCABULARY_PROMPT.length).toBeLessThan(400)
  })

  it('names the file by its real format, which is how the service tells them apart', async () => {
    const { fetchFn, seen } = fetchWith(() => new Response(GOOD))
    const t = createTranscriber({ apiKey: 'k', fetch: fetchFn })
    await t.transcribe(checkAudio(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])))
    await t.transcribe(checkAudio(new Uint8Array([0x49, 0x44, 0x33, 4])))
    expect(seen.map((s) => (s.form.get('file') as File).name)).toEqual(['voice.m4a', 'voice.mp3'])
  })

  it('maps a failing service, a bad body and a wrong shape to a TranscriptionError with the cause', async () => {
    const cases: [Response, string][] = [
      [new Response('upstream down', { status: 503 }), 'service'],
      [new Response('{"error":{"message":"provider unavailable"}}', { status: 404 }), 'service'],
      [new Response('<html>'), 'bad_response'],
      [new Response('{"text":"hola"}'), 'bad_response'],
    ]
    for (const [res, failure] of cases) {
      const t = createTranscriber({ apiKey: 'k', fetch: fetchWith(() => res).fetchFn })
      await expect(t.transcribe(OGG)).rejects.toMatchObject({ failure })
    }
    const down = createTranscriber({
      apiKey: 'k',
      fetch: fetchWith(() => {
        throw new TypeError('fetch failed')
      }).fetchFn,
    })
    await expect(down.transcribe(OGG)).rejects.toMatchObject({ failure: 'service' })
  })

  it('never puts the key in an error', async () => {
    const t = createTranscriber({
      apiKey: 'sk-very-secret',
      fetch: fetchWith(() => new Response('denied', { status: 401 })).fetchFn,
    })
    const error = await t.transcribe(OGG).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TranscriptionError)
    expect(String((error as Error).message)).not.toContain('sk-very-secret')
  })

  const hang = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as unknown as typeof fetch

  it('gives up on a service that does not answer inside its own time budget', async () => {
    const t = createTranscriber({ apiKey: 'k', fetch: hang, budgetMs: 30 })
    const started = Date.now()
    await expect(t.transcribe(OGG)).rejects.toMatchObject({ failure: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('passes the message deadline through as it is, not as a service failure', async () => {
    const deadline = new AbortController()
    const t = createTranscriber({ apiKey: 'k', fetch: hang, budgetMs: 60_000 })
    const pending = t.transcribe(OGG, deadline.signal)
    deadline.abort(new Error('deadline'))
    await expect(pending).rejects.toThrow('deadline')
  })
})
