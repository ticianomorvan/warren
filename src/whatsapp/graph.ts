import { keepAliveFetch } from '../http'

// Graph `error.code` values, from Meta's error-code reference.
const PERMANENT = new Set([100, 131026, 131030, 131047, 131051])
const RETRYABLE = new Set([4, 80007, 130429, 131048, 131056, 190])

export class GraphError extends Error {
  constructor(
    /** HTTP status of the response (200 when the body was unusable). */
    readonly http: number,
    readonly detail: string,
    /** Graph `error.code`, when the body had one. */
    readonly code?: number,
  ) {
    super(`Graph API ${http}${code ? ` (${code})` : ''}: ${detail}`)
  }

  /** An HTTP 4xx answer proves the message was not sent. 5xx and an odd 200 prove nothing. */
  get notSent(): boolean {
    return this.http >= 400 && this.http < 500
  }

  /** Trying the same call again can succeed. Permanent codes and unlisted 4xx codes cannot. */
  get retryable(): boolean {
    if (this.code !== undefined && PERMANENT.has(this.code)) return false
    if (this.code !== undefined && RETRYABLE.has(this.code)) return true
    return this.http === 429 || this.http >= 500
  }

  /** The token or the app is broken: retry, but someone has to look. */
  get alert(): boolean {
    return this.code === 190
  }
}

/**
 * The short form of a webhook `wa_id`, or the `wa_id` itself. Webhooks give Argentine mobiles as
 * `549…` and Mexican ones as `521…`, but Meta saves test-number recipients without that mobile digit
 * and matches sends against it exactly, so a send to the `wa_id` fails with 131030 there. Only used
 * as a fallback after that rejection; production sends to the `wa_id` as documented.
 */
export function shortRecipient(waId: string): string {
  const ar = /^549(\d{10})$/.exec(waId)
  if (ar) return `54${ar[1]}`
  const mx = /^521(\d{10})$/.exec(waId)
  if (mx) return `52${mx[1]}`
  return waId
}

/** Why a photo could not be given to the agent; each one has its own reply to the person. */
export type ImageProblem = 'too_large' | 'unsupported' | 'unavailable'

export class ImageError extends Error {
  constructor(
    readonly problem: ImageProblem,
    detail: string,
  ) {
    super(`image ${problem}: ${detail}`)
  }
}

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp'

/** A photo that passed the limits: the type read from its bytes and the bytes in base64. Never stored. */
export interface Image {
  mediaType: ImageType
  data: string
}

/** WhatsApp itself caps an image at 5 MB, and so does the model's API. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** The type of an image by its first bytes (what the sender claims is not trusted), or null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((v, k) => bytes[offset + k] === v)
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/** The limits on a downloaded photo: not empty, at most 5 MB, a JPEG, PNG or WebP by its bytes. */
export function checkImage(bytes: Uint8Array): Image {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError('too_large', `${bytes.length} bytes`)
  const mediaType = sniffImage(bytes)
  if (!mediaType) throw new ImageError('unsupported', 'not a JPEG, PNG or WebP')
  return { mediaType, data: Buffer.from(bytes).toString('base64') }
}

export interface Graph {
  /** Marks the message read and shows the typing indicator. */
  markReadAndType(wamid: string): Promise<void>
  /** Sends a text message to a webhook `wa_id` and returns its wamid. */
  sendText(waId: string, body: string): Promise<string>
  /** Downloads a photo by its media id (id, then URL, then bytes) within the limits; throws `ImageError`. */
  fetchImage(mediaId: string, signal?: AbortSignal): Promise<Image>
}

export interface GraphOptions {
  version: string
  phoneNumberId: string
  token: string
  fetch?: typeof fetch
  /** One budget for a photo's lookup and download together. Default 8 s. */
  mediaBudgetMs?: number
}

// Meta answers the first request on a new connection about 0.4 s slower than later ones (see
// `keepAliveFetch`). Meta kept an idle connection for at least 70 s when measured (2026-11-21).
// One connection, so the read-and-typing call just before each send proves the socket the send uses
// is alive; two sockets alternate otherwise.
// graph.facebook.com negotiates HTTP/2 with undici, so parallel calls (typing next to a send) share
// this one connection without queueing: 4 in parallel took about 338 ms in total (2026-11-21).
const keptAliveFetch = keepAliveFetch({ connections: 1 })

export function createGraph(o: GraphOptions): Graph {
  const doFetch = o.fetch ?? keptAliveFetch
  const url = `https://graph.facebook.com/${o.version}/${o.phoneNumberId}/messages`

  async function post(body: unknown): Promise<{ messages?: { id: string }[] }> {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...(body as object) }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      let code: number | undefined
      try {
        const e = JSON.parse(text).error
        detail = e.message ?? detail
        code = typeof e.code === 'number' ? e.code : undefined
      } catch {}
      throw new GraphError(res.status, detail, code)
    }
    return text ? JSON.parse(text) : {}
  }

  /** wa_ids whose send needed the short form (Meta's test-number recipient list). */
  const useShort = new Set<string>()

  /**
   * Runs one send to the `wa_id`, or to its short form once Meta has rejected the `wa_id` with 131030.
   * 131030 is a 4xx, so nothing was sent and a second try cannot duplicate the message.
   */
  async function toRecipient<T>(waId: string, call: (to: string) => Promise<T>): Promise<T> {
    const short = shortRecipient(waId)
    if (useShort.has(waId)) return call(short)
    try {
      return await call(waId)
    } catch (err) {
      if (!(err instanceof GraphError && err.code === 131030) || short === waId) throw err
      const result = await call(short)
      useShort.add(waId)
      return result
    }
  }

  /** Media URLs come from Meta's own domains; the token goes only to one of them, over https. */
  const metaHost = /(^|\.)(facebook\.com|fbsbx\.com|fbcdn\.net|whatsapp\.net|whatsapp\.com)$/

  async function readLimited(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      await res.body?.cancel()
      throw new ImageError('too_large', `${declared} bytes declared`)
    }
    const reader = res.body?.getReader()
    if (!reader) throw new ImageError('unavailable', 'no body')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new ImageError('too_large', `more than ${MAX_IMAGE_BYTES} bytes`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }

  async function download(mediaId: string, signal?: AbortSignal): Promise<Image> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(mediaId)) throw new ImageError('unavailable', 'bad media id')
    // One budget for the lookup and the download together, inside the message's own deadline. A redirect
    // is an error: the host check below is on the URL Meta named, not on wherever it might send us.
    const budget = AbortSignal.any([
      AbortSignal.timeout(o.mediaBudgetMs ?? 8_000),
      ...(signal ? [signal] : []),
    ])
    const headers = { authorization: `Bearer ${o.token}` }
    const meta = await doFetch(`https://graph.facebook.com/${o.version}/${mediaId}`, {
      headers,
      signal: budget,
      redirect: 'error',
    })
    if (!meta.ok) throw new ImageError('unavailable', `media lookup ${meta.status}`)
    const info = (await meta.json()) as { url?: unknown; mime_type?: unknown; file_size?: unknown }
    // The lookup already says how big it is and what it is: refuse before downloading anything.
    if (typeof info.file_size === 'number' && info.file_size > MAX_IMAGE_BYTES) {
      throw new ImageError('too_large', `${info.file_size} bytes declared`)
    }
    if (typeof info.mime_type === 'string' && !info.mime_type.startsWith('image/')) {
      throw new ImageError('unsupported', info.mime_type)
    }
    let url: URL
    try {
      url = new URL(String(info.url))
    } catch {
      throw new ImageError('unavailable', 'no media url')
    }
    if (url.protocol !== 'https:' || !metaHost.test(url.hostname)) {
      throw new ImageError('unavailable', `media host ${url.hostname} is not Meta's`)
    }
    const res = await doFetch(url.href, { headers, signal: budget, redirect: 'error' })
    if (!res.ok) {
      await res.body?.cancel()
      throw new ImageError('unavailable', `media download ${res.status}`)
    }
    return checkImage(await readLimited(res))
  }

  return {
    async fetchImage(mediaId, signal) {
      try {
        return await download(mediaId, signal)
      } catch (err) {
        if (err instanceof ImageError || signal?.aborted) throw err
        throw new ImageError('unavailable', err instanceof Error ? err.message : String(err))
      }
    },
    async markReadAndType(wamid) {
      await post({ status: 'read', message_id: wamid, typing_indicator: { type: 'text' } })
    },
    sendText: (waId, body) =>
      toRecipient(waId, async (to) => {
        const res = await post({ recipient_type: 'individual', to, type: 'text', text: { body } })
        const id = res.messages?.[0]?.id
        if (!id) throw new GraphError(200, 'no message id in response')
        return id
      }),
  }
}
