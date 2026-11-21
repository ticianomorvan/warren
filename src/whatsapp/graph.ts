export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Graph API ${status}: ${detail}`)
  }
  /** A 4xx other than rate limiting will fail the same way again, so the sweep must not retry it. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
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
      try {
        const e = JSON.parse(text).error
        detail = `${e.code ?? ''} ${e.message ?? ''}`.trim() || detail
      } catch {}
      throw new GraphError(res.status, detail)
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
      if (!id) throw new GraphError(502, 'no message id in response')
      return id
    },
  }
}
