import { log } from './log'
import type { Claim, Store } from './store'
import { type Graph, GraphError } from './whatsapp/graph'

export const REPLY_TEXT = 'recibido'
export const REPLY_NON_TEXT = 'por ahora solo entiendo texto'

export interface ProcessorOptions {
  store: Store
  graph: Graph
  /** Normalized ids that get a reply; `*` means everyone. Empty answers nobody. */
  allowed: string[]
  maxAttempts: number
}

export const isAllowed = (allowed: string[], waId: string) =>
  allowed.includes('*') || allowed.includes(waId)

/**
 * Sends at most one reply per message. `send_started_at` is committed before the Graph call; a
 * row that dies after that is `unknown` and is never sent again. Only an HTTP 4xx answer, which
 * proves nothing was sent, returns a row to `pending`.
 *
 * A worker's time is bounded by two 10 s Graph timeouts plus the database, far under the store's
 * stale threshold, and every write after the claim is guarded, so a takeover cannot be undone.
 */
export function createProcessor(o: ProcessorOptions) {
  const { store, graph } = o
  const inflight = new Set<Promise<unknown>>()
  let sweeping = false

  async function work(c: Claim): Promise<void> {
    if (!isAllowed(o.allowed, c.wa_id)) {
      await store.settle(c, 'ignored', 'sender not allowed')
      log('message_ignored', { wamid: c.wamid })
      return
    }

    const timings: Record<string, number> = {}
    try {
      await graph.markReadAndType(c.wamid)
      const ms = await store.recordTyping(c)
      if (ms !== null) timings.typing_ms = Math.round(ms)
    } catch (err) {
      // The indicator is cosmetic: still answer.
      log('typing_failed', { wamid: c.wamid, error: errorText(err) })
    }

    if (!(await store.recordSendStarted(c))) {
      log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
      return
    }

    let outbound: string
    try {
      outbound = await graph.sendText(c.wa_id, c.kind === 'text' ? REPLY_TEXT : REPLY_NON_TEXT)
    } catch (err) {
      const error = errorText(err)
      if (err instanceof GraphError && err.notSent) {
        const retry = err.retryable && c.attempts < o.maxAttempts
        await store.settle(c, retry ? 'pending' : 'failed', error)
        log(
          'message_error',
          { wamid: c.wamid, attempt: c.attempts, code: err.code, retry, error, ...timings },
          err.alert || !retry ? 'error' : 'info',
        )
      } else {
        // A timeout, a network error or a 5xx: Meta may have accepted it. Do not send again.
        await store.settle(c, 'unknown', error)
        log('message_unknown', { wamid: c.wamid, attempt: c.attempts, error, ...timings }, 'error')
      }
      return
    }

    // The reply is out. If this write fails the row goes `unknown` by staleness, never resent.
    const replyMs = await store.recordReplySent(c, outbound)
    log('message_done', {
      wamid: c.wamid,
      attempt: c.attempts,
      outbound,
      ...timings,
      ...(replyMs === null ? { late: true } : { reply_ms: Math.round(replyMs) }),
    })
  }

  async function run(c: Claim): Promise<void> {
    try {
      await work(c)
    } catch (err) {
      log('process_crash', { wamid: c.wamid, error: errorText(err) }, 'error')
    }
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p)
    p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    )
    return p
  }

  /** Claims and processes these messages now, if they are due. Never throws. */
  function kick(wamids: string[]): Promise<void> {
    if (wamids.length === 0) return Promise.resolve()
    return track(
      (async () => {
        const claims = await store.claimDue({ limit: wamids.length, wamids })
        await Promise.all(claims.map(run))
      })().catch((err) => log('kick_error', { error: errorText(err) }, 'error')),
    )
  }

  /** The recovery pass. Skipped when the previous one is still running. */
  async function sweep(): Promise<number> {
    if (sweeping) return 0
    sweeping = true
    const done = track(
      (async () => {
        const claims = await store.claimDue({ limit: 50 })
        for (const c of claims) await run(c)
        if (claims.length) log('sweep', { claimed: claims.length })
        return claims.length
      })(),
    )
    try {
      return await done
    } finally {
      sweeping = false
    }
  }

  /** Waits for work in flight, at most `ms`. For shutdown. */
  async function drain(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => {
        timer = setTimeout(r, ms)
      }),
    ])
    clearTimeout(timer)
  }

  return { kick, sweep, drain }
}

export type Processor = ReturnType<typeof createProcessor>

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}
