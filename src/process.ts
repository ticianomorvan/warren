import Anthropic from '@anthropic-ai/sdk'
import {
  type Action,
  AgentError,
  type AuditEntry,
  type ContextInput,
  contextFacts,
  estimateCostUsd,
  type ModelKey,
  renderContext,
  runAgent,
  type Usage,
  windowReplies,
} from './agent'
import { sensitive } from './agent/memory'
import { actionLabel, execute } from './execute'
import { RECENT_LIMIT } from './ledger'
import { log } from './log'
import { isSecretNotice, scrubAudit, scrubCalls } from './redact'
import {
  REPLY_AUDIO,
  REPLY_FAILED,
  REPLY_IMAGE,
  REPLY_INTERIM,
  REPLY_NON_TEXT,
  REPLY_VOICE,
} from './render'
import { answerAction, disconnectRequest, linkCode, undoRequest } from './resolve'
import type { Claim, Store } from './store'
import { argentinaTime, argentinaToday } from './time'
import type { Timings, TurnTiming } from './timings'
import { judgeTranscript, type Transcriber, TranscriptionError } from './transcribe'
import { type Graph, GraphError, type Image, MediaError } from './whatsapp/graph'

export interface ProcessorOptions {
  store: Store
  graph: Graph
  /** Normalized ids that get a reply; `*` means everyone. Empty answers nobody. */
  allowed: string[]
  maxAttempts: number
  /** The agent's model. Defaults to Haiku, the slice 1 choice. */
  model?: ModelKey
  /** The Anthropic client; the shared keep-alive client when omitted. Tests inject a fake. */
  client?: Anthropic
  /** A human contact line for the help reply. */
  helpContact?: string
  /** Turns voice notes into text. Without one, a voice note is answered with a request for text. */
  transcriber?: Transcriber
  /** Connecting an agent over MCP is on (docs/mcp-spec.md): "vincular <code>", and the "sí" to its question. Off: those messages are ordinary text. */
  signIn?: boolean
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
 * A text message runs: the agent (with the typing indicator started alongside), then the commit point
 * (actions, movements and rendered reply in one transaction), then the send.
 * Until the commit point the message can fail: an agent run that fails for good (a model error, no
 * valid action in 3 turns), or the deadline, ends it
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
  /** Aborted by `shutdown`: runs that have not reached the commit point give their rows back. */
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
  const fail = (
    c: Claim,
    reason: string,
    trace?: { audit: AuditEntry[]; turns: number },
    stages?: Timings,
    /** The message's text, when it is not the row's own (a voice note's transcript). */
    text = c.body ?? '',
  ) =>
    once(
      'failure_notice',
      c,
      async () => {
        // A message that holds a secret leaves no trace of it, not even in a failed one.
        const redact = sensitive(text)
        const ok = await store.recordFailure(
          c,
          reason,
          redact && trace ? { ...trace, audit: scrubAudit(trace.audit) } : trace,
          stages,
          redact,
        )
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
    stages: Timings = { claimed_ms: Math.round(c.ageMs) },
  ): Promise<boolean> {
    const stamping = performance.now()
    if (!(await store.recordSendStarted(c))) {
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
    stages.send_ms = Math.round(performance.now() - sending)
    const replyMs = await store.recordReplySent(c, outbound, stages)
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

  /**
   * Runs the agent on a text message that has no stored reply yet, commits it, and answers. `age` is how long
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
    const isPhoto = c.kind === 'image'
    // The download starts with the first signal, beside the database reads, and is awaited only when
    // the model needs it. A photo that cannot be read is answered, not failed. A voice note's download
    // and transcription run the same way; what was heard then stands in for the person's text.
    const download = isPhoto ? fetchPhoto(graph, c, signal) : null
    download?.catch(() => {})
    const hearing =
      c.kind === 'audio' && o.transcriber ? hear(o.transcriber, graph, c, signal) : null
    hearing?.catch(() => {})
    let text = c.body ?? ''
    let heard: string | undefined
    const stages: Timings = { claimed_ms: Math.round(c.ageMs) }
    const working = (async (): Promise<Worked> => {
      const readsAt = performance.now()
      const accountId = await store.upsertAccount(c.wa_id)
      let [movements, conversation, memory] = await Promise.all([
        store.recentMovements(accountId),
        store.conversation(c),
        store.facts(accountId, c.body ?? ''),
      ])
      stages.reads_ms = Math.round(performance.now() - readsAt)
      const mediaAt = performance.now()
      const photo = await download
      const voice = await hearing
      if (download || hearing) stages.media_ms = Math.round(performance.now() - mediaAt)
      // Answers that need no model: a photo or voice note that cannot be used, a bare answer to our question.
      const unprompted = (
        action: Action,
        entry: Omit<AuditEntry, 'turn' | 'ms' | 'action'>,
      ): Worked => ({
        accountId,
        actions: [action],
        parsed: null,
        audit: [{ ...entry, turn: 0, ms: 0, action: 0 }],
        turns: 0,
        ms: 0,
        usage: null,
        turnLog: [],
        facts: [],
        window: [],
      })
      if (photo && 'problem' in photo) {
        log('photo_unreadable', {
          wamid: c.wamid,
          problem: photo.problem.problem,
          detail: photo.problem.message,
        })
        return unprompted(
          { tool: 'notice', input: { text: REPLY_IMAGE[photo.problem.problem] } },
          {
            tool: 'notice',
            input: { media_id: c.mediaId },
            status: 'answered',
            detail: photo.problem.message,
          },
        )
      }
      if (voice && 'notice' in voice) {
        log('voice_unusable', { wamid: c.wamid, cause: voice.cause, detail: voice.detail })
        return unprompted(
          { tool: 'notice', input: { text: voice.notice } },
          {
            tool: 'notice',
            input: { media_id: c.mediaId },
            status: 'answered',
            detail: `${voice.cause}: ${voice.detail}`,
          },
        )
      }
      if (voice) {
        text = voice.heard
        heard = voice.heard
        // The facts the message names are known only now that it is heard.
        memory = await store.facts(accountId, text)
      }
      // A bare answer to the question we just asked, or a bare "deshacer", is code's job: no model call at all. Not for a
      // note of voice: a delete, a correction or an undo is never run on what a model of speech thought it heard. A
      // "deshacer" while a question is open most likely means "never mind", not "undo the batch before": the model reads it.
      // "vincular <code>" comes first, whatever else is open (typed text only, like every answer code gives). The "sí" or
      // "no" to its question is `answerAction`'s: the question is the previous reply's own, so the newest one owns it.
      const code = o.signIn && c.kind === 'text' ? linkCode(text) : null
      const answer =
        isPhoto || voice
          ? null
          : code
            ? ({ tool: 'link_ask', input: { code } } as const)
            : (answerAction(text, conversation.question) ??
              (conversation.question
                ? null
                : (undoRequest(text) ?? (o.signIn ? disconnectRequest(text) : null))))
      if (answer) {
        return unprompted(answer, { tool: answer.tool, input: answer.input, status: 'answered' })
      }
      const seen = new Set([
        ...movements.map((m) => m.id),
        ...(conversation.question?.asked.map((a) => a.id) ?? []),
      ])
      const context: ContextInput = {
        text,
        today,
        time: argentinaTime(c.messageAt),
        movements,
        memory: memory.facts,
        memoryTotal: memory.total,
        // Fewer than the list holds: it is everything they have, and a search could find nothing more.
        complete: movements.length > 0 && movements.length < RECENT_LIMIT,
        conversation: conversation.turns,
        photo: Boolean(photo),
        voice: Boolean(voice),
        // The sign-in's question is code's alone: the model is not told about it.
        pending:
          conversation.question && conversation.question.pending?.action !== 'link'
            ? conversation.question.pending?.action === 'forget_all'
              ? { asked: [], action: 'forget_all' }
              : {
                  asked: conversation.question.asked,
                  action: conversation.question.pending?.action ?? 'none',
                }
            : null,
      }
      const result = await runAgent({
        client: o.client ?? defaultClient(),
        model: o.model ?? 'haiku',
        context: renderContext(context),
        ...(photo ? { photo: photo.image } : {}),
        facts: contextFacts(context),
        window: windowReplies(context),
        message: text,
        today,
        env: { find: (filter) => store.find(accountId, filter) },
        seen,
        seenFacts: new Set(memory.facts.map((f) => f.id)),
        sole:
          conversation.question?.asked.length === 1
            ? conversation.question.asked[0]?.id
            : undefined,
        signal,
      })
      return {
        accountId,
        parsed: result.actions,
        heard,
        facts: contextFacts(context, result.found),
        window: windowReplies(context),
        ...result,
      }
    })().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    try {
      const outcome = await Promise.race([working, aborted])
      if (deadline.aborted)
        return await fail(c, 'deadline passed before the commit point', undefined, stages, text)
      if (shutdown.signal.aborted) {
        // Nothing was committed and no send started: hand the row to the next process at once.
        await store.settle(c, 'pending', 'shutdown before the commit point')
        log('message_released', { wamid: c.wamid })
        return
      }
      if (outcome === 'aborted') return
      if ('error' in outcome) {
        const e = outcome.error
        // A failed message keeps what the agent tried; it writes nothing to the ledger.
        const trace = e instanceof AgentError ? { audit: e.audit, turns: e.turns } : undefined
        if (e instanceof AgentError) stages.turns = e.turnLog
        return await fail(c, `parse failed: ${errorText(e)}`, trace, stages, text)
      }

      const { accountId, actions, parsed, audit, turns, ms, usage, turnLog, facts, window, heard } =
        outcome.value
      stages.turns = turnLog
      // A secret in the message, or one the model tried to store: it is stored nowhere (`redact.ts`).
      const redact = sensitive(text) || actions.some(isSecretNotice)

      // The commit point. Nothing awaits between the signal check above and this call.
      let reply: string | null
      const committing = performance.now()
      try {
        reply = await store.commit(c, {
          parsed: redact ? scrubCalls(parsed) : parsed,
          command: redact ? scrubCalls(actions) : actions,
          redact,
          action: actionLabel(actions),
          turns,
          modelMs: ms,
          heard,
          execute: (tx) =>
            execute(tx, {
              accountId,
              inboundId: c.id,
              actions,
              audit,
              today,
              message: text,
              facts,
              window,
              heard,
              redact,
              render: { helpContact: o.helpContact },
            }),
        })
      } catch (err) {
        return await fail(c, `commit failed: ${errorText(err)}`, undefined, stages)
      }
      stages.commit_ms = Math.round(performance.now() - committing)
      if (reply === null) {
        log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
        return
      }
      const model_ms = Math.round(ms)
      log('committed', {
        wamid: c.wamid,
        action: actionLabel(actions),
        turns,
        model_ms,
        ...(usage
          ? { ...usage, cost_usd: Number(estimateCostUsd(o.model ?? 'haiku', usage).toFixed(6)) }
          : {}),
      })
      // What this message changed is stored: the sender's next message may start its parse.
      release()
      await closeInterim()
      await deliver(c, reply, { typing_ms: await typing, model_ms }, stages)
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

    const voice = c.kind === 'audio' && o.transcriber !== undefined
    if (c.kind !== 'text' && c.kind !== 'image' && !voice) {
      release() // stores nothing the sender's next message could depend on
      const typing_ms = await showTyping(c)
      // A voice note is the one non-text kind people send to log something: say what to do instead.
      await deliver(c, c.kind === 'audio' ? REPLY_AUDIO : REPLY_NON_TEXT, { typing_ms })
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
      await fail(c, 'deadline passed before the commit point', undefined, {
        claimed_ms: Math.round(c.ageMs),
      })
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

/** What the agent half of a message gives the commit point. */
interface Worked {
  accountId: number
  actions: Action[]
  parsed: unknown
  audit: AuditEntry[]
  turns: number
  ms: number
  usage: Usage | null
  /** Each model call, for the stored timings. */
  turnLog: TurnTiming[]
  /** What the model's words may take numbers from (see `contextFacts`). */
  facts: string[]
  /** What Warren answered earlier (see `windowReplies`). */
  window: string[]
  /** What was heard in a voice note, which the reply starts with. */
  heard?: string
}

/** The photo of a message, or why it cannot be read. Anything else (the deadline's abort) is thrown. */
function fetchPhoto(
  graph: Graph,
  c: Claim,
  signal: AbortSignal,
): Promise<{ image: Image } | { problem: MediaError }> {
  if (!c.mediaId) {
    return Promise.resolve({
      problem: new MediaError('unavailable', 'the webhook has no media id'),
    })
  }
  return graph.fetchImage(c.mediaId, signal).then(
    (image) => ({ image }),
    (error: unknown) => {
      if (error instanceof MediaError) return { problem: error }
      throw error
    },
  )
}

/** A voice note that could not be used, answered with `notice`; `cause` and `detail` go to the log and the audit, not to the person. */
interface Unheard {
  notice: string
  cause: string
  detail: string
}

/**
 * The words of a voice note, or why they cannot be used: its download (the same limits as a photo's),
 * the transcription and the confidence gate. A failure is a notice, never silence; only the message's
 * own deadline (the abort) is thrown.
 */
async function hear(
  transcriber: Transcriber,
  graph: Graph,
  c: Claim,
  signal: AbortSignal,
): Promise<{ heard: string } | Unheard> {
  if (!c.mediaId) {
    return {
      notice: REPLY_VOICE.failed,
      cause: 'unavailable',
      detail: 'the webhook has no media id',
    }
  }
  try {
    const audio = await graph.fetchAudio(c.mediaId, signal)
    const verdict = judgeTranscript(await transcriber.transcribe(audio, signal))
    if (verdict.ok) return { heard: verdict.text }
    return {
      notice: verdict.reason === 'too_long' ? REPLY_VOICE.too_large : REPLY_VOICE.unclear,
      cause: `refused ${verdict.reason}`,
      detail: verdict.detail,
    }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof MediaError) {
      const notice =
        error.problem === 'unavailable' ? REPLY_VOICE.failed : REPLY_VOICE[error.problem]
      return { notice, cause: error.problem, detail: error.message }
    }
    if (error instanceof TranscriptionError) {
      return { notice: REPLY_VOICE.failed, cause: error.failure, detail: error.message }
    }
    throw error
  }
}

let shared: Anthropic | undefined

/** One client per process, reading ANTHROPIC_API_KEY from the environment; the server injects its own. */
function defaultClient(): Anthropic {
  shared ??= new Anthropic()
  return shared
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}
