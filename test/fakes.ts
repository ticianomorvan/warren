import type Anthropic from '@anthropic-ai/sdk'
import type { Movement } from '../src/agent'
import { argentinaToday } from '../src/time'
import type { Segment, Transcriber, Transcript } from '../src/transcribe'
import {
  type Audio,
  checkAudio,
  checkImage,
  type Graph,
  type Image,
  MediaError,
} from '../src/whatsapp/graph'

/** A tool call block as the API returns it. Typed to the SDK, so a change in its shape breaks here. */
export const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
})

/** A complete `Message` as the API returns it, around the given blocks. Typed to the SDK. */
export const message = (
  content: Anthropic.ContentBlock[],
  o: { stop_reason?: Anthropic.StopReason; usage?: Partial<Anthropic.Usage> } = {},
): Anthropic.Message => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  container: null,
  content,
  diagnostics: null,
  stop_details: null,
  stop_reason: o.stop_reason ?? 'tool_use',
  stop_sequence: null,
  usage: {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 10,
    output_tokens: 10,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...o.usage,
  },
})

export type SendFn = (n: number) => Promise<string>

/** A photo or voice note the fake Graph serves under a media id: its bytes, or the error its download raises. */
export type FakeMedia = Uint8Array | Error

/**
 * A Graph double that records calls. `send` and `typing` can be replaced to fail or to hang; `media`
 * holds the photos by media id. A photo goes through the same limits as the real download (`checkImage`).
 */
export function fakeGraph(
  o: {
    send?: SendFn
    /** Replaces `send` for templates only. */
    sendTemplate?: SendFn
    typing?: () => Promise<void>
    media?: Record<string, FakeMedia>
    /** Holds a download until it resolves. */
    download?: () => Promise<void>
  } = {},
) {
  const calls = {
    typing: [] as string[],
    sent: [] as { to: string; body: string }[],
    templates: [] as { to: string; name: string; lang: string; params: string[] }[],
    downloads: [] as string[],
    /** The abort signal each download was given: the message's own deadline. */
    signals: [] as (AbortSignal | undefined)[],
    attempts: 0,
  }
  const graph: Graph = {
    async markReadAndType(wamid) {
      calls.typing.push(wamid)
      await o.typing?.()
    },
    async fetchImage(mediaId): Promise<Image> {
      calls.downloads.push(mediaId)
      await o.download?.()
      const media = o.media?.[mediaId]
      if (media === undefined) throw new MediaError('unavailable', 'no such media')
      if (media instanceof Error) throw media
      return checkImage(media)
    },
    async fetchAudio(mediaId, signal): Promise<Audio> {
      calls.downloads.push(mediaId)
      calls.signals.push(signal)
      await o.download?.()
      const media = o.media?.[mediaId]
      if (media === undefined) throw new MediaError('unavailable', 'no such media')
      if (media instanceof Error) throw media
      return checkAudio(media)
    },
    async sendText(to, body) {
      calls.attempts++
      const id = o.send ? await o.send(calls.attempts) : `wamid.OUT${calls.attempts}`
      calls.sent.push({ to, body })
      return id
    },
    async sendTemplate(to, name, lang, params) {
      calls.attempts++
      const id = o.sendTemplate
        ? await o.sendTemplate(calls.attempts)
        : `wamid.TPL${calls.attempts}`
      calls.templates.push({ to, name, lang, params })
      return id
    },
  }
  return { graph, calls }
}

/** The bytes of a tiny Ogg file: enough to pass the fake Graph's limits (`checkAudio` reads the type from them). */
export const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])

/** One segment the way the service measures a good, clear one (Ticiano's real notes: -0.18 to -0.25, 0.76 to 1.06). */
export const CLEAR: Segment = {
  start: 0,
  end: 4,
  avg_logprob: -0.2,
  compression_ratio: 1,
  no_speech_prob: 0.005,
}
/** What the service gives for a note: the text and its one segment, clear unless `segment` says otherwise. */
export const heard = (text: string, segment: Partial<Segment> = {}): Transcript => ({
  text: ` ${text}`,
  segments: [{ ...CLEAR, ...segment }],
})

/** A transcription answer: what is heard, an error to throw, or a function (to hold or inspect the call). */
export type FakeHeard = Transcript | Error | ((signal?: AbortSignal) => Promise<Transcript>)

/** A transcription double that records what it was given. A list answers call by call, the last one for the rest. */
export function fakeTranscriber(answer: FakeHeard | FakeHeard[] = heard('café 3500')) {
  const calls: { audio: Audio }[] = []
  const transcriber: Transcriber = {
    async transcribe(audio, signal) {
      calls.push({ audio })
      const now = Array.isArray(answer) ? (answer[calls.length - 1] ?? answer.at(-1)) : answer
      const result = typeof now === 'function' ? await now(signal) : now
      if (result === undefined) throw new Error('no answer scripted')
      if (result instanceof Error) throw result
      return result
    },
  }
  return { transcriber, calls }
}

// The day comes from the message's own time (meta_ts), as in the processor, so midnight cannot flake.
export const TODAY = argentinaToday(new Date(1760000000 * 1000))
export const cafeMovement: Movement = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: TODAY,
  description: 'café',
  category: 'restaurantes',
  payment: 'visa',
  confidence: 'high',
}
/** One tool call a scripted model makes. */
export type ToolCall = { name: string; input: unknown }
export const logCall = (...movements: Movement[]): ToolCall => ({
  name: 'log_movements',
  input: { movements, text: null },
})
/** The model answers in its own words. */
export const replyCall = (text: string): ToolCall => ({ name: 'reply', input: { text } })
/** The model asks for the canned help text. */
export const helpCall: ToolCall = { name: 'help', input: {} }
/** What a model returns for "café 3500". */
export const cafe: ToolCall[] = [logCall(cafeMovement)]

/** What a scripted model sees of one request: its number (from 1) and the params the loop sent. */
export type ModelRequest = { n: number; params: Anthropic.MessageCreateParamsNonStreaming }
/** One model turn: the tool calls it makes. */
export type ModelFn = (
  signal: AbortSignal | undefined,
  request: ModelRequest,
) => Promise<ToolCall[]> | ToolCall[]

/**
 * An Anthropic double: `messages.create` answers each request with the tool calls `model` gives, or
 * throws what it throws. `requests` keeps every request the loop sent, to look at its context.
 */
export function fakeModel(model: ModelFn = () => cafe) {
  const calls = { n: 0 }
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<Anthropic.Message> => {
        calls.n++
        requests.push(structuredClone(params))
        const turn = await model(options?.signal, { n: calls.n, params })
        return message(turn.map((c, k) => toolUse(`toolu_${calls.n}_${k}`, c.name, c.input)))
      },
    },
  } as unknown as Anthropic
  return { client, calls, requests }
}
