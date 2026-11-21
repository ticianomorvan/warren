import { FormData } from 'undici'
import { z } from 'zod'
import { keepAliveFetch } from './http'
import type { Audio } from './whatsapp/graph'

/**
 * Voice notes become text here, and only here. The text then goes through the pipeline as the person's
 * message, so everything downstream (the model, the numbers check, the guards) is the one a typed message gets.
 *
 * The service is OpenRouter's `POST /audio/transcriptions` (OpenAI-compatible, multipart) with
 * `openai/whisper-large-v3`. Tested on real notes 2026-11-21: unpinned it routes to DeepInfra, which
 * heard "YPF" as "IPEF" and "¿Cuánto va este mes?" as "en cuanto a este mes". Pinned to Groq the
 * transcripts matched Groq direct, at 0.75 to 1.0 s a note.
 */

export const TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
export const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3'
/** Only Groq, and no fallback: a provider that is down is a clear failure notice, not a worse transcript. */
export const PROVIDER_PIN = { order: ['groq'], allow_fallbacks: false }

/**
 * What the speech is likely to be about, so that names and slang come out right ("YPF", "lucas").
 * Groq reads at most 224 tokens of it.
 */
export const VOCABULARY_PROMPT =
  'Gastos e ingresos en pesos argentinos: café, súper, nafta, YPF, Shell, lucas, mangos, visa, débito, Mercado Pago, Rappi, Uber.'

/** The ways a transcription can fail, as the person never sees them: the cause goes in the log. */
export type TranscriptionFailure = 'timeout' | 'service' | 'bad_response'

export class TranscriptionError extends Error {
  constructor(
    readonly failure: TranscriptionFailure,
    detail: string,
  ) {
    super(`transcription ${failure}: ${detail}`)
  }
}

const segmentSchema = z.object({
  start: z.number().finite(),
  end: z.number().finite(),
  // The ranges the service keeps; an answer outside them is not trusted, whatever it says.
  avg_logprob: z.number().finite().max(0),
  compression_ratio: z.number().finite().min(0),
  no_speech_prob: z.number().finite().min(0).max(1),
})
const responseSchema = z.object({
  text: z.string(),
  segments: z.array(segmentSchema),
})

export type Segment = z.infer<typeof segmentSchema>
/** What the service heard: the text and how sure the model was of each stretch of it. */
export type Transcript = z.infer<typeof responseSchema>

export interface Transcriber {
  /** Throws `TranscriptionError`; the message's own deadline (`signal`) is rethrown as it is. */
  transcribe(audio: Audio, signal?: AbortSignal): Promise<Transcript>
}

export interface TranscriberOptions {
  apiKey: string
  fetch?: typeof fetch
  url?: string
  /** Own time budget for the call, inside the message's deadline. Default 10 s (a note takes about 1 s). */
  budgetMs?: number
}

const sharedFetch = keepAliveFetch({ connections: 2 })

export function createTranscriber(o: TranscriberOptions): Transcriber {
  const doFetch = o.fetch ?? sharedFetch
  return {
    async transcribe(audio, signal) {
      const form = new FormData()
      form.set('model', TRANSCRIPTION_MODEL)
      form.set('language', 'es')
      form.set('temperature', '0')
      form.set('response_format', 'verbose_json')
      form.set('prompt', VOCABULARY_PROMPT)
      form.set('provider', JSON.stringify(PROVIDER_PIN))
      form.set(
        'file',
        new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type: audio.mediaType }),
        `voice.${audio.extension}`,
      )
      const budget = AbortSignal.timeout(o.budgetMs ?? 10_000)
      try {
        const res = await doFetch(o.url ?? TRANSCRIPTION_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}` },
          body: form,
          signal: signal ? AbortSignal.any([budget, signal]) : budget,
        })
        const text = await res.text()
        if (!res.ok)
          throw new TranscriptionError('service', `HTTP ${res.status}: ${text.slice(0, 200)}`)
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          throw new TranscriptionError('bad_response', 'not JSON')
        }
        const parsed = responseSchema.safeParse(json)
        if (!parsed.success) throw new TranscriptionError('bad_response', 'no text or segments')
        return parsed.data
      } catch (err) {
        if (err instanceof TranscriptionError || signal?.aborted) throw err
        if (budget.aborted)
          throw new TranscriptionError('timeout', `no answer in ${o.budgetMs ?? 10_000} ms`)
        throw new TranscriptionError('service', err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/**
 * The confidence gate. Whisper writes something for any sound: beatboxing came back as ".", "¡Hola!",
 * "Subtitulado por…" and "Chika-chika, chika-chika" (Groq's draws differ from call to call, even at
 * temperature 0). Measured 2026-11-21 on Ticiano's real notes, 3 good ones and 10 draws of the noise:
 *
 *                      good speech   noise
 *   avg_logprob        -0.18 to -0.25   -0.18 to -2.52 (most under -0.4)
 *   compression_ratio  0.76 to 1.06     0.20 to 2.26 (the "chika" loops 1.74 to 2.26)
 *   no_speech_prob     0.001 to 0.008   0.16 on every draw
 *
 * Each threshold sits well clear of the good notes and the three together refuse all 10 draws.
 * It is a handful of notes: widen with care and re-run `evals/voice-probe.ts` on new ones.
 */
export const GATE = {
  /** The mean (by duration) of the segments' avg_logprob must be at least this... */
  minMeanLogprob: -0.4,
  /** ...and no single segment may fall under this (Whisper's own threshold). */
  minSegmentLogprob: -1.0,
  /** A segment that compresses better than this is a loop of the same few sounds. */
  maxCompressionRatio: 1.5,
  /** The mean probability that there was no speech at all. */
  maxNoSpeechProb: 0.1,
  /**
   * A transcript longer than this is not a note about an expense: a message logs at most 10 movements, about 60
   * characters each said aloud, so 1,000 is more than a minute of speech and room to spare. It also keeps the
   * reply, which starts with what was heard, far from WhatsApp's 4,096-character limit.
   */
  maxChars: 1000,
} as const

export type RefusalReason = 'empty' | 'too_long' | 'low_confidence' | 'repetitive' | 'no_speech'

export type Heard =
  | { ok: true; text: string }
  | { ok: false; reason: RefusalReason; detail: string }

/**
 * The mean of `pick` weighted by each segment's duration. NaN when the numbers do not allow one (times that
 * overflow): the checks below are written so that a NaN is a refusal.
 */
const mean = (segments: Segment[], pick: (s: Segment) => number) => {
  const weight = (s: Segment) => Math.max(s.end - s.start, 0.01)
  const total = segments.reduce((sum, s) => sum + weight(s), 0)
  return segments.reduce((sum, s) => sum + pick(s) * weight(s), 0) / total
}

/** Smallest and largest, without spreading the array into arguments (a huge one would throw). */
const lowest = (segments: Segment[], pick: (s: Segment) => number) =>
  segments.reduce((low, s) => Math.min(low, pick(s)), Number.POSITIVE_INFINITY)
const highest = (segments: Segment[], pick: (s: Segment) => number) =>
  segments.reduce((high, s) => Math.max(high, pick(s)), Number.NEGATIVE_INFINITY)

/** One line of text with single spaces: the transcript as the person's message. */
export const cleanTranscript = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Whether what was heard may go on as the person's message, and the text as it will be used. */
export function judgeTranscript(t: Transcript): Heard {
  const text = cleanTranscript(t.text)
  const no = (reason: RefusalReason, detail: string): Heard => ({ ok: false, reason, detail })
  if (!/[\p{L}\p{N}]/u.test(text) || t.segments.length === 0) return no('empty', `"${text}"`)
  if (text.length > GATE.maxChars) return no('too_long', `${text.length} characters`)
  // Every check is written to fail closed: a NaN (from numbers the service should never send) is a refusal.
  const logprob = mean(t.segments, (s) => s.avg_logprob)
  const worst = lowest(t.segments, (s) => s.avg_logprob)
  if (!(logprob >= GATE.minMeanLogprob && worst >= GATE.minSegmentLogprob)) {
    return no('low_confidence', `avg_logprob mean ${logprob.toFixed(2)}, worst ${worst.toFixed(2)}`)
  }
  const ratio = highest(t.segments, (s) => s.compression_ratio)
  if (!(ratio <= GATE.maxCompressionRatio))
    return no('repetitive', `compression_ratio ${ratio.toFixed(2)}`)
  const silence = mean(t.segments, (s) => s.no_speech_prob)
  if (!(silence <= GATE.maxNoSpeechProb))
    return no('no_speech', `no_speech_prob ${silence.toFixed(2)}`)
  return { ok: true, text }
}
