// Graph `error.code` values, from Meta's error-code reference.
const PERMANENT = new Set([100, 131026, 131047, 131051])
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

export interface Graph {
  /** Marks the message read and shows the typing indicator. */
  markReadAndType(wamid: string): Promise<void>
  /** Sends a text message and returns its wamid. */
  sendText(to: string, body: string): Promise<string>
}

export interface GraphOptions {
  version: string
  phoneNumberId: string
  token: string
  fetch?: typeof fetch
}

/**
 * Node's global fetch (undici) pools keep-alive connections per origin, so repeated calls to
 * graph.facebook.com reuse one TLS connection without a custom agent.
 */
export function createGraph(o: GraphOptions): Graph {
  const doFetch = o.fetch ?? fetch
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

  return {
    async markReadAndType(wamid) {
      await post({ status: 'read', message_id: wamid, typing_indicator: { type: 'text' } })
    },
    async sendText(to, body) {
      const res = await post({ recipient_type: 'individual', to, type: 'text', text: { body } })
      const id = res.messages?.[0]?.id
      if (!id) throw new GraphError(200, 'no message id in response')
      return id
    },
  }
}
