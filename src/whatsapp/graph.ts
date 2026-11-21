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

export interface Graph {
  /** Marks the message read and shows the typing indicator. */
  markReadAndType(wamid: string): Promise<void>
  /** Sends a text message to a webhook `wa_id` and returns its wamid. */
  sendText(waId: string, body: string): Promise<string>
}

export interface GraphOptions {
  version: string
  phoneNumberId: string
  token: string
  fetch?: typeof fetch
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

  return {
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
