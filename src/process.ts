import type Anthropic from '@anthropic-ai/sdk'
import { execute } from './execute'
import { log } from './log'
import { type ModelKey, parseMessage } from './parse'
import { REPLY_BAD_CHANGE, REPLY_FAILED, REPLY_INTERIM, REPLY_NON_TEXT } from './render'
import type { Claim, Store } from './store'
import { argentinaToday } from './time'
import { type Graph, GraphError } from './whatsapp/graph'

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
 * (command, movements and rendered reply in one transaction), then the send.
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
  /** Aborted by `shutdown`: parses that have not reached the commit point give their rows back. */
  const shutdown = new AbortController()
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

  /**
   * "Stamp, then send, never again": `stamp` commits that the message is going out (false means do
   * not send), then `send` runs. A failure of either is only logged, so nothing here is retried.
   */
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

  /** The failure path: one notice, only if the reply send never started and nothing was committed. */
  const fail = (c: Claim, reason: string) =>
    once(
      'failure_notice',
      c,
      async () => {
        const ok = await store.recordFailure(c, reason)
        log(ok ? 'message_failed' : 'failure_skipped', { wamid: c.wamid, reason }, 'error')
        return ok
      },
      async () => store.recordFailureSent(c, await graph.sendText(c.wa_id, REPLY_FAILED)),
      'error',
    )

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

  /**
   * Parses a text message that has no stored reply yet, commits it, and answers. `age` is how long
   * ago the message was received. One signal ends the wait before the commit point: the 30 s
   * deadline, or the shutdown of this process. It is checked right before the commit starts, with
   * no await in between, so no commit starts after it. A deadline that fires while the commit is
   * running loses: committed means the reply is sent, late if need be.
   */
  async function parseAndAnswer(c: Claim, age: number, release: () => void): Promise<void> {
    const deadline = AbortSignal.timeout(Math.max(0, Math.ceil(deadlineMs - age)))
    const signal = AbortSignal.any([deadline, shutdown.signal])
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted')
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })

    let interim: Promise<void> | undefined
    let interimAgain: Promise<void> | undefined
    const interimTimer = setTimeout(
      () => {
        interim = once(
          'interim',
          c,
          () => store.recordInterim(c),
          async () => {
            await graph.sendText(c.wa_id, REPLY_INTERIM)
            log('interim_sent', { wamid: c.wamid })
            // The typing indicator again, without holding the reply back.
            interimAgain = graph.markReadAndType(c.wamid).catch(() => {})
          },
        )
      },
      Math.max(0, interimMs - age),
    )
    /**
     * No new interim note after this, and one on its way (with its typing call) finishes before the
     * reply: a typing call landing after the reply would show "typing…" for up to 25 s. Only slow
     * messages have one, so the wait (~0.4 s) costs nothing that matters.
     */
    const closeInterim = async () => {
      clearTimeout(interimTimer)
      await interim
      await interimAgain
    }

    const typing = c.typingSent ? Promise.resolve(undefined) : showTyping(c)
    const today = argentinaToday(c.messageAt)
    const parsing = (async () => {
      const accountId = await store.upsertAccount(c.wa_id)
      const recentMovements = await store.recentMovements(accountId)
      const result = await parseMessage({
        text: c.body ?? '',
        today,
        recentMovements,
        model: o.model ?? 'haiku',
        client: o.client,
        signal,
      })
      return { accountId, result, recentMovements }
    })().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    try {
      const outcome = await Promise.race([parsing, aborted])
      if (deadline.aborted) return await fail(c, 'deadline passed before the commit point')
      if (shutdown.signal.aborted) {
        // Nothing was committed and no send started: hand the row to the next process at once.
        await store.settle(c, 'pending', 'shutdown before the commit point')
        log('message_released', { wamid: c.wamid })
        return
      }
      if (outcome === 'aborted') return
      if ('error' in outcome) return await fail(c, `parse failed: ${errorText(outcome.error)}`)

      const { accountId, result, recentMovements } = outcome.value
      const { command } = result
      // A correction's value that cannot be stored is the person's to rewrite: say so, change nothing.
      const badChange = command.type === 'correct' && result.fatal.length > 0
      if (result.fatal.length > 0 && !badChange) {
        const detail = result.fatal.map((i) => `${i.path}: ${i.message}`).join('; ')
        return await fail(c, `invalid model output: ${detail}`)
      }

      // The commit point. Nothing awaits between the signal check above and this call.
      let reply: string | null
      try {
        reply = await store.commit(c, {
          command,
          modelMs: result.latencyMs,
          execute: (tx) =>
            badChange
              ? Promise.resolve(REPLY_BAD_CHANGE)
              : execute(tx, {
                  accountId,
                  inboundId: c.id,
                  command,
                  today,
                  text: c.body ?? '',
                  recent: recentMovements,
                  render: { helpContact: o.helpContact },
                }),
        })
      } catch (err) {
        return await fail(c, `commit failed: ${errorText(err)}`)
      }
      if (reply === null) {
        log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
        return
      }
      const model_ms = Math.round(result.latencyMs)
      log('committed', { wamid: c.wamid, command: command.type, model_ms })
      // What this message changed is stored: the sender's next message may start its parse.
      release()
      await closeInterim()
      await deliver(c, reply, { typing_ms: await typing, model_ms })
    } finally {
      await closeInterim()
      await typing
    }
  }

  async function work(c: Claim, release: () => void): Promise<void> {
    if (!isAllowed(o.allowed, c.wa_id)) {
      await store.settle(c, 'ignored', 'sender not allowed')
      log('message_ignored', { wamid: c.wamid })
      return
    }

    if (c.kind !== 'text') {
      release() // stores nothing the sender's next message could depend on
      const typing_ms = await showTyping(c)
      await deliver(c, REPLY_NON_TEXT, { typing_ms })
      return
    }
    if (c.replyText !== null) {
      // Committed earlier, send never started: the stored reply goes out, the model is not called.
      release()
      const typing_ms = c.typingSent ? undefined : await showTyping(c)
      await deliver(c, c.replyText, { typing_ms })
      return
    }
    // A sweep claims many rows and works them in turn: age each from when its own work starts.
    const age = c.ageMs + (performance.now() - c.claimedAt)
    if (age >= deadlineMs) {
      await fail(c, 'deadline passed before the commit point')
      return
    }
    await parseAndAnswer(c, age, release)
  }

  async function runNow(c: Claim, release: () => void): Promise<void> {
    try {
      if (shutdown.signal.aborted) {
        // Queued behind another message of the same sender when the shutdown came: nothing started.
        await store.settle(c, 'pending', 'shutdown before the work started')
        log('message_released', { wamid: c.wamid })
        return
      }
      await work(c, release)
    } catch (err) {
      log('process_crash', { wamid: c.wamid, error: errorText(err) }, 'error')
    }
  }

  /** The tail of each sender's chain of work. */
  const lanes = new Map<string, Promise<void>>()

  /**
   * One sender's messages are handled in the order they were handed in (kick and sweep alike). A
   * message reads its context before the parse, so it must not start until the previous one has
   * stored what it changed ("café 3500", then "uy, era 3800" must find the café). The turn passes
   * at that commit, not at the send, so a burst does not also wait on each reply's send. Different
   * senders run in parallel. Single process, so a promise chain is enough.
   */
  function run(c: Claim): Promise<void> {
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = lanes.get(c.wa_id) ?? Promise.resolve()
    lanes.set(c.wa_id, turn)
    void turn.then(() => {
      if (lanes.get(c.wa_id) === turn) lanes.delete(c.wa_id)
    })
    // Every path ends the turn: a failure, a lost claim or a crash releases it in `finally`.
    return previous.then(() => runNow(c, release)).finally(release)
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
    if (wamids.length === 0 || shutdown.signal.aborted) return Promise.resolve()
    return track(
      (async () => {
        const claims = await store.claimDue({ limit: wamids.length, wamids })
        await Promise.all(claims.map(run))
      })().catch((err) => log('kick_error', { error: errorText(err) }, 'error')),
    )
  }

  /** The recovery pass. Skipped when the previous one is still running. */
  async function sweep(): Promise<number> {
    if (sweeping || shutdown.signal.aborted) return 0
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

  /**
   * For SIGTERM: stop taking work, give back every message that is still parsing (it goes to
   * `pending`, so the next process answers it inside its deadline), then wait for sends in flight.
   */
  async function stop(ms: number): Promise<void> {
    shutdown.abort(new Error('shutdown'))
    await drain(ms)
  }

  return { kick, sweep, drain, stop }
}

export type Processor = ReturnType<typeof createProcessor>

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}
