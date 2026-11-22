import type { AuditEntry } from '../agent/loop'
import { sensitive } from '../core/secrets'
import { log } from '../log'
import { scrubAudit } from '../redact'
import type { Timings } from '../timings'
import { type Graph, GraphError } from './graph'
import type { Claim, Queue } from './queue'
import { REPLY_FAILED } from './replies'

/**
 * Everything the worker says to the person goes through here, under one rule: stamp, then send, never again. `send_started_at` is
 * committed before the Graph call; a row that dies after that is `unknown` and is never sent again. Only an HTTP 4xx answer, which
 * proves nothing was sent, returns a row to `pending`.
 */

export const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500)

export interface SenderOptions {
  graph: Graph
  queue: Queue
  maxAttempts: number
}

export function createSender({ graph, queue, maxAttempts }: SenderOptions) {
  /** Read receipt plus typing indicator. Cosmetic: a failure is only logged. Returns ms since received. */
  async function showTyping(c: Claim): Promise<number | undefined> {
    try {
      await graph.markReadAndType(c.wamid)
      const ms = await queue.recordTyping(c)
      return ms === null ? undefined : Math.round(ms)
    } catch (err) {
      log('typing_failed', { wamid: c.wamid, error: errorText(err) })
    }
  }

  /** "Stamp, then send, never again": `stamp` commits that the message is going out (false means do not send), then `send` runs. A failure of either is only logged, so nothing here is retried. */
  async function once(
    what: string,
    c: Claim,
    stamp: () => Promise<boolean>,
    send: () => Promise<unknown>,
    level: 'info' | 'error' = 'info',
  ): Promise<void> {
    try {
      if (await stamp()) await send()
    } catch (err) {
      log(`${what}_failed`, { wamid: c.wamid, error: errorText(err) }, level)
    }
  }

  /** The failure path: one notice, only if the reply send never started and nothing was committed. A secret in the message leaves no trace of it, not even in a failed one. */
  const fail = (
    c: Claim,
    reason: string,
    o: { audit?: AuditEntry[]; stages?: Timings; text?: string } = {},
  ) =>
    once(
      'failure_notice',
      c,
      async () => {
        const redact = sensitive(o.text ?? c.text ?? '')
        const ok = await queue.recordFailure(
          c,
          reason,
          o.audit ? { audit: redact ? scrubAudit(o.audit) : o.audit } : undefined,
          o.stages,
          redact,
        )
        log(ok ? 'message_failed' : 'failure_skipped', { wamid: c.wamid, reason }, 'error')
        return ok
      },
      async () => queue.recordFailureSent(c, await graph.sendText(c.wa_id, REPLY_FAILED)),
      'error',
    )

  /** The at-most-once send of the reply. True when it is out and recorded. */
  async function deliver(
    c: Claim,
    text: string,
    timings: Record<string, number | undefined>,
    stages: Timings = { claimed_ms: Math.round(c.ageMs) },
  ): Promise<boolean> {
    const stamping = performance.now()
    if (!(await queue.recordSendStarted(c))) {
      log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
      return false
    }
    const sending = performance.now()
    stages.stamp_ms = Math.round(sending - stamping)

    let outbound: string
    try {
      outbound = await graph.sendText(c.wa_id, text)
    } catch (err) {
      const error = errorText(err)
      if (err instanceof GraphError && err.notSent) {
        const retry = err.retryable && c.attempts < maxAttempts
        await queue.settle(c, retry ? 'pending' : 'failed', error)
        log(
          'message_error',
          { wamid: c.wamid, attempt: c.attempts, code: err.code, retry, error, ...timings },
          err.alert || !retry ? 'error' : 'info',
        )
      } else {
        // A timeout, a network error or a 5xx: Meta may have accepted it. Do not send again.
        await queue.settle(c, 'unknown', error)
        log('message_unknown', { wamid: c.wamid, attempt: c.attempts, error, ...timings }, 'error')
      }
      return false
    }

    // The reply is out. If this write fails the row goes `unknown` by staleness, never resent.
    stages.send_ms = Math.round(performance.now() - sending)
    const replyMs = await queue.recordReplySent(c, outbound, stages)
    log('message_done', {
      wamid: c.wamid,
      attempt: c.attempts,
      outbound,
      ...timings,
      send_ms: stages.send_ms,
      ...(replyMs === null ? { late: true } : { reply_ms: Math.round(replyMs) }),
    })
    return true
  }

  return { showTyping, once, fail, deliver }
}

export type Sender = ReturnType<typeof createSender>
