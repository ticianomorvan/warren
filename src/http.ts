import { Agent, fetch as undiciFetch } from 'undici'

export interface KeepAliveOptions {
  /** Sockets to keep per origin. Unlimited when omitted. */
  connections?: number
}

/**
 * A `fetch` with its own keep-alive pool. Node's global fetch drops idle sockets after 4 s, so a call
 * a few seconds after the last one pays a new TCP and TLS handshake every time. Measured 2026-11-21:
 * keep-alive saved about 0.3 s on Haiku calls 8 s apart, and about 0.4 s on Graph. 60 s keeps the
 * socket across a burst of messages; undici also drops it early if the server closes it or sends a
 * shorter `Keep-Alive`. The `signal` of each call still reaches undici, so a deadline cancels it.
 */
export function keepAliveFetch(o: KeepAliveOptions = {}): typeof fetch {
  const agent = new Agent({ ...o, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 })
  return ((url: string, init: RequestInit) =>
    undiciFetch(url, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch
}
