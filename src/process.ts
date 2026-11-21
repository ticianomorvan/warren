import type Anthropic from '@anthropic-ai/sdk'
import { log } from './log'
import { type ModelKey, parseMessage } from './parse'
import { REPLY_FAILED, REPLY_INTERIM, REPLY_NON_TEXT, renderReply } from './render'
import type { Claim, Store } from './store'
import { argentinaToday } from './time'
import { type Graph, GraphError } from './whatsapp/graph'

const DONE_MARK = '✅'

export interface ProcessorOptions {
  store: Store
  graph: Graph
  /** Normalized ids that get a reply; `*` means everyone. Empty answers nobody. */
  allowed: string[]
  maxAttempts: number
  /** Parser model. Defaults to Haiku, the slice 1 choice. */
  model?: ModelKey
  /** The Anthropic client; the shared keep-alive client when omitted. Tests inject a fake. */
  client?: Anthropic
  /** A human contact line for the help reply. */
  helpContact?: string
  /** Ms after `received_at` at which a slow message gets one interim note. Default 10 s. */
  interimMs?: number
  /** Ms after `received_at` at which an uncommitted message fails. Default 30 s. */
  deadlineMs?: number
}

export const isAllowed = (allowed: string[], waId: string) =>
  allowed.includes('*') || allowed.includes(waId)

/**
 * Sends at most one reply per message. `send_started_at` is committed before the Graph call; a
 * row that dies after that is `unknown` and is never sent again. Only an HTTP 4xx answer, which
 * proves nothing was sent, returns a row to `pending`.
 *
 * A text message runs: parse (with the typing indicator started alongside), then the commit point
 * (command, movements and rendered reply in one transaction), then the send, then the done mark.
 * Until the commit point the message can fail: a parse that fails for good, or the deadline, ends it
 * as `failed` with one failure notice, and a late model result is dropped. After the commit point
 * the stored reply is always sent, even late, because the movements already exist and a failure
 * notice would make the person resend them.
 *
 * A worker's time is bounded by the deadline plus two 10 s Graph timeouts and the database, far under
 * the store's stale threshold, and every write after the claim is guarded, so a takeover cannot be
 * undone.
 */
export function createProcessor(o: ProcessorOptions) {
  const { store, graph } = o
  const interimMs = o.interimMs ?? 10_000
  const deadlineMs = o.deadlineMs ?? 30_000
  const inflight = new Set<Promise<unknown>>()
  let sweeping = false

  /** Read receipt plus typing indicator. Cosmetic: a failure is only logged. */
  async function showTyping(c: Claim): Promise<number | undefined> {
    try {
      await graph.markReadAndType(c.wamid)
      const ms = await store.recordTyping(c)
      return ms === null ? undefined : Math.round(ms)
    } catch (err) {
      log('typing_failed', { wamid: c.wamid, error: errorText(err) })
    }
  }

  /** The slow-message note, at most once: its timestamp is committed before the send. Cosmetic. */
  async function sendInterim(c: Claim): Promise<void> {
    try {
      if (!(await store.recordInterim(c))) return
      await graph.sendText(c.wa_id, REPLY_INTERIM)
      log('interim_sent', { wamid: c.wamid })
      await graph.markReadAndType(c.wamid)
    } catch (err) {
      log('interim_failed', { wamid: c.wamid, error: errorText(err) })
    }
  }

  /** The failure path: one notice, only if the reply send never started, never retried. */
  async function fail(c: Claim, reason: string): Promise<void> {
    if (!(await store.recordFailure(c, reason))) {
      log('failure_skipped', { wamid: c.wamid, reason })
      return
    }
    log('message_failed', { wamid: c.wamid, attempt: c.attempts, reason }, 'error')
    try {
      await store.recordFailureSent(c, await graph.sendText(c.wa_id, REPLY_FAILED))
    } catch (err) {
      log('failure_notice_failed', { wamid: c.wamid, error: errorText(err) }, 'error')
    }
  }

  /** The done mark, best effort: committed before the call, never retried. */
  async function react(c: Claim): Promise<void> {
    try {
      if (await store.recordReaction(c)) await graph.sendReaction(c.wa_id, c.wamid, DONE_MARK)
    } catch (err) {
      log('reaction_failed', { wamid: c.wamid, error: errorText(err) })
    }
  }

  /** The at-most-once send. True when the reply is out and recorded. */
  async function deliver(
    c: Claim,
    text: string,
    timings: Record<string, number | undefined>,
  ): Promise<boolean> {
    if (!(await store.recordSendStarted(c))) {
      log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
      return false
    }

    let outbound: string
    try {
      outbound = await graph.sendText(c.wa_id, text)
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
      return false
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
    return true
  }

  /** Parses a text message that has no stored reply yet, commits it, and answers. */
  async function parseAndAnswer(c: Claim): Promise<void> {
    // 'running' until the commit point starts. The deadline and a failed parse move it to 'failed'
    // and a result that arrives after that is dropped. Checked and set without an await between.
    let phase: 'running' | 'committing' | 'failed' = 'running'
    const abort = new AbortController()
    const timers: NodeJS.Timeout[] = []
    let interim: Promise<void> | undefined

    const deadline = new Promise<'deadline'>((resolve) => {
      timers.push(
        setTimeout(
          () => {
            if (phase === 'running') {
              phase = 'failed'
              abort.abort(new Error('deadline'))
            }
            resolve('deadline')
          },
          Math.max(0, deadlineMs - c.ageMs),
        ),
      )
    })
    const interimTimer = c.interimSent
      ? undefined
      : setTimeout(
          () => {
            if (phase === 'running') interim = sendInterim(c)
          },
          Math.max(0, interimMs - c.ageMs),
        )
    /** No new interim note after this, and one already on its way finishes before the reply. */
    const closeInterim = async () => {
      clearTimeout(interimTimer)
      await interim
    }

    const typing = c.typingSent ? Promise.resolve(undefined) : showTyping(c)
    const parsing = (async () => {
      const accountId = await store.upsertAccount(c.wa_id)
      const recentMovements = await store.recentMovements(accountId)
      const today = argentinaToday()
      const result = await parseMessage({
        text: c.body ?? '',
        today,
        recentMovements,
        model: o.model ?? 'haiku',
        client: o.client,
        signal: abort.signal,
      })
      return { accountId, today, result }
    })().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    let reply: string
    try {
      const outcome = await Promise.race([parsing, deadline])
      let reason: string | undefined
      if (outcome === 'deadline' || phase !== 'running')
        reason = 'deadline passed before the commit point'
      else if ('error' in outcome) reason = `parse failed: ${errorText(outcome.error)}`
      else {
        const { accountId, today, result } = outcome.value
        const { command, issues } = result
        // Every problem but "too many movements" means a value that cannot be stored as it is.
        const unusable = issues.filter((i) => i.path !== 'movements')
        if (unusable.length > 0) {
          reason = `invalid model output: ${unusable.map((i) => `${i.path}: ${i.message}`).join('; ')}`
        } else {
          reply = renderReply(command, today, { helpContact: o.helpContact })
          phase = 'committing'
          const committed = await store.commit(c, {
            accountId,
            command,
            modelMs: result.latencyMs,
            reply,
            movements: command.type === 'log' ? command.movements : [],
          })
          if (!committed) {
            log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
            return
          }
          log('committed', {
            wamid: c.wamid,
            command: command.type,
            model_ms: Math.round(result.latencyMs),
          })
          await closeInterim()
          if (
            await deliver(c, reply, {
              typing_ms: await typing,
              model_ms: Math.round(result.latencyMs),
            })
          )
            await react(c)
          return
        }
      }
      phase = 'failed'
      abort.abort(new Error('failed'))
      await closeInterim()
      await fail(c, reason)
    } finally {
      for (const t of timers) clearTimeout(t)
      clearTimeout(interimTimer)
      await typing
    }
  }

  async function work(c: Claim): Promise<void> {
    if (!isAllowed(o.allowed, c.wa_id)) {
      await store.settle(c, 'ignored', 'sender not allowed')
      log('message_ignored', { wamid: c.wamid })
      return
    }

    if (c.kind !== 'text') {
      const typing_ms = await showTyping(c)
      await deliver(c, REPLY_NON_TEXT, { typing_ms })
      return
    }
    if (c.replyText !== null) {
      // Committed earlier, send never started: the stored reply goes out, the model is not called.
      const typing_ms = c.typingSent ? undefined : await showTyping(c)
      if (await deliver(c, c.replyText, { typing_ms })) await react(c)
      return
    }
    if (c.ageMs >= deadlineMs) {
      await fail(c, 'deadline passed before the commit point')
      return
    }
    await parseAndAnswer(c)
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
