import type Anthropic from '@anthropic-ai/sdk'
import { isAllowed } from '../access'
import { readState } from '../agent/context'
import { AgentError, type AuditEntry } from '../agent/loop'
import { estimateCostUsd, type ModelKey } from '../agent/models'
import { compose, type HelpOptions, render } from '../agent/reply'
import { understand } from '../agent/understand'
import { disconnectAccount } from '../auth/disconnect'
import { askLink, confirmLink, declineLink } from '../auth/link'
import { type Call, labelOf } from '../core/commands'
import type { Sql } from '../core/db'
import { sensitive } from '../core/secrets'
import { commit, type Done, type Question } from '../core/turn'
import { liveFacts } from '../domain/facts'
import { log } from '../log'
import { REDACTED_BODY, scrubAudit } from '../redact'
import { argentinaToday } from '../time'
import type { Timings, TurnTiming } from '../timings'
import type { Transcriber } from '../transcribe'
import type { Graph } from './graph'
import { accountFor } from './ingest'
import { fetchPhoto, hear } from './media'
import { type Claim, createQueue } from './queue'
import {
  REPLY_AUDIO,
  REPLY_DISCONNECT,
  REPLY_IMAGE,
  REPLY_INTERIM,
  REPLY_LINK,
  REPLY_NON_TEXT,
} from './replies'
import { codeAnswer } from './resolve'
import { createSender, errorText } from './send'

export interface WorkerOptions {
  sql: Sql
  graph: Graph
  /** Normalized ids that get a reply; `*` means everyone. Empty answers nobody. */
  allowed: string[]
  maxAttempts: number
  /** A `processing` row older than this is presumed abandoned (a worker that died). */
  staleMs: number
  /** The Anthropic client. */
  client: Anthropic
  /** The agent's model. Defaults to Haiku. */
  model?: ModelKey
  /** A human contact line for the help reply. */
  helpContact?: string
  /** Turns voice notes into text. Without one, a voice note is answered with a request for text. */
  transcriber?: Transcriber
  /** Connecting an agent over MCP is on: "vincular <code>", the "sí" to its question, "desconectar". Off: those messages are ordinary text. */
  signIn?: boolean
  /** Ms after `received_at` at which a slow message gets one interim note. Default 10 s. */
  interimMs?: number
  /** Ms after `received_at` at which an uncommitted message fails. Default 30 s. */
  deadlineMs?: number
  /**
   * The clock. A reminder's time is judged against the later of the message's own time and this: a message that waited (an outage, a
   * long deploy) must not set a reminder for a moment that has already gone by. Tests and the scenario eval give a fixed past one,
   * since their messages carry made-up times.
   */
  clock?: () => Date
}

/** What the agent half of a message gives the commit point. */
interface Worked {
  accountId: number
  /** The calls, how the reply is composed and what is stored beside the turn. */
  calls: Call[]
  compose: (done: Done[], record: string | null) => { reply: string; question?: Question | null }
  label?: string
  audit: AuditEntry[]
  turns: number
  ms: number
  cost: number | null
  turnLog: TurnTiming[]
  /** The message held something Warren must not keep (see `redact.ts`). */
  redact: boolean
  /** What was heard in a voice note, stored as the message's text. */
  heard?: string
  /** Runs inside the commit transaction before the account lock (the sign-in's own SQL); false ends it. */
  before?: (tx: Sql) => Promise<boolean>
}

/**
 * The WhatsApp worker: takes each sender's messages in order and answers them, at most once.
 *
 * A message runs: the claim (the queue's SQL: the sender's oldest due row, only when no older row of the sender is open, uncommitted and
 * not stale), the typing indicator started beside the work, then either what code answers with no model call, or the agent; then the commit
 * point (`core/turn.commit`: the writes, the turn row and `wa_message.turn_id` in one transaction), then the send. Until the commit point
 * the message can fail: an agent run that fails for good (a model error, a refusal, no valid call in 3 turns), or the deadline, ends it as
 * `failed` with one failure notice, and a late model result is dropped. After the commit point the stored reply is always sent, even late,
 * because the movements already exist and a failure notice would make the person resend them.
 *
 * A worker's time is bounded by the deadline plus two 10 s Graph timeouts and the database, far under the stale threshold, and every write
 * after the claim is guarded, so a takeover cannot be undone.
 *
 * Ordering is the database's: a claim never takes a row while an older one of the same sender is held by anyone (this process or the old
 * instance of a deploy). In process, one lane per sender claims, works until the commit point and claims the next; different senders run in
 * parallel, and a sender's replies are sent in the order its messages came.
 */
export function createWorker(o: WorkerOptions) {
  const { sql, graph } = o
  const interimMs = o.interimMs ?? 10_000
  const deadlineMs = o.deadlineMs ?? 30_000
  const clock = o.clock ?? (() => new Date())
  const model = o.model ?? 'haiku'
  const help: HelpOptions = {
    ...(o.helpContact ? { helpContact: o.helpContact } : {}),
    disconnect: o.signIn === true,
  }
  const queue = createQueue(sql, { staleMs: o.staleMs, maxAttempts: o.maxAttempts })
  const sender = createSender({ graph, queue, maxAttempts: o.maxAttempts })
  const inflight = new Set<Promise<unknown>>()
  /** Aborted by `stop`: runs that have not reached the commit point give their rows back. */
  const shutdown = new AbortController()
  let sweeping = false

  /** The commit point and what follows it, for one message. */
  async function parseAndAnswer(
    c: Claim,
    age: number,
    release: () => void,
    sent: Promise<void>,
  ): Promise<void> {
    const deadline = AbortSignal.timeout(Math.max(0, Math.ceil(deadlineMs - age)))
    const deadlineAt = Date.now() + Math.max(0, deadlineMs - age)
    const signal = AbortSignal.any([deadline, shutdown.signal])
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted')
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })

    let interim: Promise<void> | undefined
    let interimAgain: Promise<void> | undefined
    const interimTimer = setTimeout(
      () => {
        interim = sender.once(
          'interim',
          c,
          () => queue.recordInterim(c),
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
     * No new interim note after this, and one on its way (with its typing call) finishes before the reply: a typing call landing after
     * the reply would show "typing…" for up to 25 s. Only slow messages have one, so the wait (~0.4 s) costs nothing that matters.
     */
    const closeInterim = async () => {
      clearTimeout(interimTimer)
      await interim
      await interimAgain
    }

    // Sent again at the claim even when the first signal went out on receipt: the reply to the message before may have cleared it.
    const typing =
      c.typingSent && c.attempts > 1 ? Promise.resolve(undefined) : sender.showTyping(c)
    const at = c.messageAt
    const today = argentinaToday(at)
    // "Now" for reminders: when the person wrote, or later if the message waited (see `WorkerOptions.clock`).
    const now = new Date(Math.max(at.getTime(), clock().getTime()))
    // The download starts with the first signal, beside the database reads, and is awaited only when the model needs it. A photo that
    // cannot be read is answered, not failed. A voice note's download and transcription run the same way; what was heard then stands
    // in for the person's text.
    const download = c.kind === 'image' ? fetchPhoto(graph, c.mediaId, signal) : null
    download?.catch(() => {})
    const hearing =
      c.kind === 'audio' && o.transcriber ? hear(o.transcriber, graph, c.mediaId, signal) : null
    hearing?.catch(() => {})
    let text = c.text ?? ''
    const stages: Timings = { claimed_ms: Math.round(c.ageMs) }

    const working = (async (): Promise<Worked> => {
      const accountId = await accountFor(sql, c.wa_id)
      const readsAt = performance.now()
      let read = await readState(sql, accountId, at, text)
      stages.reads_ms = Math.round(performance.now() - readsAt)
      const mediaAt = performance.now()
      const photo = await download
      const voice = await hearing
      if (download || hearing) stages.media_ms = Math.round(performance.now() - mediaAt)
      /** An answer that needs no model and writes nothing: a photo or voice note that cannot be used. */
      const notice = (reply: string, cause: string, detail: string): Worked => ({
        accountId,
        calls: [],
        compose: () => ({ reply }),
        label: 'notice',
        audit: [
          {
            turn: 0,
            tool: 'notice',
            input: { media_id: c.mediaId },
            status: 'answered',
            detail: `${cause}: ${detail}`,
            ms: 0,
          },
        ],
        turns: 0,
        ms: 0,
        cost: null,
        turnLog: [],
        redact: false,
      })
      if (photo && 'problem' in photo) {
        log('photo_unreadable', {
          wamid: c.wamid,
          problem: photo.problem.problem,
          detail: photo.problem.message,
        })
        return notice(
          REPLY_IMAGE[photo.problem.problem],
          photo.problem.problem,
          photo.problem.message,
        )
      }
      if (voice && 'notice' in voice) {
        log('voice_unusable', { wamid: c.wamid, cause: voice.cause, detail: voice.detail })
        return notice(voice.notice, voice.cause, voice.detail)
      }
      let heard: string | undefined
      if (voice) {
        text = voice.heard
        heard = voice.heard
        // The facts the message names are known only now that it is heard.
        read = { ...read, memory: await liveFacts(sql, accountId, text) }
      }
      // A bare answer to the question we just asked, "vincular <code>", a bare "deshacer": code's job, no model call (resolve.ts).
      const answer = codeAnswer(text, {
        question: read.open?.question ?? null,
        typed: c.kind === 'text',
        signIn: o.signIn === true,
      })
      if (answer) return answered(accountId, answer, today)
      const u = await understand({
        sql,
        client: o.client,
        model,
        accountId,
        text,
        at,
        now,
        read,
        ...(photo ? { photo: photo.image } : {}),
        ...(voice ? { voice: true } : {}),
        help,
        signal,
        deadlineAt,
      })
      return {
        accountId,
        calls: u.calls,
        compose: u.compose,
        audit: u.audit,
        turns: u.turns,
        ms: u.ms,
        cost: estimateCostUsd(model, u.usage),
        turnLog: u.turnLog,
        redact: u.redact,
        ...(heard ? { heard } : {}),
      }
    })().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    try {
      const outcome = await Promise.race([working, aborted])
      if (deadline.aborted) {
        return await ordered(sent, () =>
          sender.fail(c, 'deadline passed before the commit point', { stages, text }),
        )
      }
      if (shutdown.signal.aborted) {
        // Nothing was committed and no send started: hand the row to the next process at once.
        await queue.settle(c, 'pending', 'shutdown before the commit point')
        log('message_released', { wamid: c.wamid })
        return
      }
      if (outcome === 'aborted') return
      if ('error' in outcome) {
        const e = outcome.error
        // A failed message keeps what the agent tried (and a refusal's category); it writes nothing to the ledger.
        if (e instanceof AgentError) stages.turns = e.turnLog
        return await ordered(sent, () =>
          sender.fail(c, `parse failed: ${errorText(e)}`, {
            ...(e instanceof AgentError ? { audit: e.audit } : {}),
            stages,
            text,
          }),
        )
      }

      const w = outcome.value
      stages.turns = w.turnLog
      // A secret in the message, or one the model tried to store: it is stored nowhere (`redact.ts`).
      const redact = w.redact || sensitive(text)

      // The commit point. Nothing awaits between the signal check above and this call.
      const committing = performance.now()
      let committed: Awaited<ReturnType<typeof commit>>
      try {
        committed = await commit(sql, {
          accountId: w.accountId,
          channel: 'whatsapp',
          now: at,
          calls: w.calls,
          ...(w.label ? { label: w.label } : {}),
          before: async (tx) =>
            (await queue.holds(tx, c)) && (w.before ? await w.before(tx) : true),
          compose: w.compose,
          scrub: redact,
          after: async (tx, turn) => {
            await queue.linkTurn(tx, c, turn.id, {
              ...(redact ? { text: REDACTED_BODY } : w.heard ? { text: w.heard } : {}),
              audit: redact ? scrubAudit(w.audit) : w.audit,
              timings: { ...stages, model_ms: Math.round(w.ms) },
            })
          },
        })
      } catch (err) {
        return await ordered(sent, () =>
          sender.fail(c, `commit failed: ${errorText(err)}`, { stages }),
        )
      }
      stages.commit_ms = Math.round(performance.now() - committing)
      if (committed === null) {
        log('claim_lost', { wamid: c.wamid, attempt: c.attempts })
        return
      }
      log('committed', {
        wamid: c.wamid,
        label: w.label ?? labelOf(w.calls),
        turns: w.turns,
        model_ms: Math.round(w.ms),
        ...(w.cost !== null ? { cost_usd: Number(w.cost.toFixed(6)) } : {}),
      })
      // What this message changed is stored: the sender's next message may start its parse.
      release()
      await closeInterim()
      await sent
      await sender.deliver(
        c,
        committed.reply,
        { typing_ms: await typing, model_ms: Math.round(w.ms) },
        stages,
      )
    } finally {
      await closeInterim()
      await typing
    }
  }

  /** What a message that is only an answer comes to: a call through the commit point like the model's own, or the sign-in's SQL. */
  async function answered(
    accountId: number,
    answer: NonNullable<ReturnType<typeof codeAnswer>>,
    today: string,
  ): Promise<Worked> {
    const base = {
      accountId,
      audit: [] as AuditEntry[],
      turns: 0,
      ms: 0,
      cost: null,
      turnLog: [] as TurnTiming[],
      redact: false,
    }
    const traced = (tool: string, input: unknown, status = 'answered'): AuditEntry[] => [
      { turn: 0, tool, input, status, ms: 0 },
    ]
    if (answer.kind === 'call') {
      const rendered = await render(sql, accountId, [answer.call], today, help)
      return {
        ...base,
        calls: [answer.call],
        audit: traced(answer.call.tool, answer.call.input),
        compose: (done, record) =>
          compose(
            {
              rendered,
              declined: [],
              evidence: { numbers: [], words: [], window: [] },
              redact: false,
            },
            done,
            record,
          ),
      }
    }
    // Connecting an agent (docs/mcp-spec.md, Design 3): no registry tool, the sign-in's own SQL, inside the commit transaction (so a message
    // that is processed again, or never committed, has changed nothing). Code asks; the question the reply carries is the one only the very
    // next "sí" or "no" can answer.
    let reply = ''
    let question: Question | null = null
    const tool =
      answer.kind === 'link_ask'
        ? 'link_ask'
        : answer.kind === 'link_confirm'
          ? 'link_confirm'
          : answer.kind === 'link_decline'
            ? 'link_decline'
            : 'mcp_disconnect'
    const audit = traced(tool, answer.kind === 'link_ask' ? { code: '[redacted]' } : {})
    const entry = audit[0] as AuditEntry
    const run = async (tx: Sql): Promise<void> => {
      switch (answer.kind) {
        case 'link_ask': {
          const asked = await askLink(tx, answer.code, accountId)
          reply = asked ? REPLY_LINK.ask(asked.client) : REPLY_LINK.refused
          entry.status = asked ? 'asked' : 'refused'
          if (asked) question = { options: [], then: { do: 'link', link_id: asked.id } }
          return
        }
        case 'link_confirm': {
          const client = await confirmLink(tx, answer.linkId, accountId)
          reply = client ? REPLY_LINK.done(client) : REPLY_LINK.refused
          entry.status = client ? 'applied' : 'gone'
          return
        }
        case 'link_decline': {
          const closed = await declineLink(tx, answer.linkId, accountId)
          reply = REPLY_LINK.declined
          entry.status = closed ? 'applied' : 'gone'
          return
        }
        case 'disconnect': {
          const cut = await disconnectAccount(tx, accountId)
          reply = cut === 0 ? REPLY_DISCONNECT.none : REPLY_DISCONNECT.done(cut)
          entry.status = cut === 0 ? 'nothing' : 'applied'
        }
      }
    }
    const done: Worked = {
      ...base,
      calls: [],
      label: tool,
      audit,
      compose: () => ({ reply, question }),
      before: async (tx) => {
        await run(tx)
        return true
      },
    }
    return done
  }

  /** A send that waits for the sender's earlier replies to be out first: a burst is answered in order. */
  const ordered = async (sent: Promise<void>, send: () => Promise<unknown>): Promise<void> => {
    await sent
    await send()
  }

  async function work(c: Claim, release: () => void, sent: Promise<void>): Promise<void> {
    if (!isAllowed(o.allowed, c.wa_id)) {
      await queue.settle(c, 'ignored', 'sender not allowed')
      log('message_ignored', { wamid: c.wamid })
      return
    }
    const voice = c.kind === 'audio' && o.transcriber !== undefined
    if (c.kind !== 'text' && c.kind !== 'image' && !voice) {
      release() // stores nothing the sender's next message could depend on
      const typing_ms = await sender.showTyping(c)
      // A voice note is the one non-text kind people send to log something: say what to do instead.
      await ordered(sent, () =>
        sender.deliver(c, c.kind === 'audio' ? REPLY_AUDIO : REPLY_NON_TEXT, { typing_ms }),
      )
      return
    }
    if (c.reply !== null) {
      // Committed earlier, send never started: the stored reply goes out, the model is not called.
      release()
      const typing_ms = c.typingSent ? undefined : await sender.showTyping(c)
      await ordered(sent, () => sender.deliver(c, c.reply as string, { typing_ms }))
      return
    }
    // A sweep claims many rows and works them in turn: age each from when its own work starts.
    const age = c.ageMs + (performance.now() - c.claimedAt)
    if (age >= deadlineMs) {
      await ordered(sent, () =>
        sender.fail(c, 'deadline passed before the commit point', {
          stages: { claimed_ms: Math.round(c.ageMs) },
        }),
      )
      return
    }
    await parseAndAnswer(c, age, release, sent)
  }

  /** Per sender: the tail of the chain of sends, and the lane that claims. */
  const tails = new Map<string, Promise<void>>()
  const lanes = new Map<string, { again: boolean; done: Promise<void> }>()

  /**
   * Works one claimed row up to its commit point (or its end, when it never commits) and returns then, so the lane can claim the next
   * message of the sender while this one's reply is sent. The returned `finished` is everything, the send included.
   */
  function start(c: Claim): { released: Promise<void>; finished: Promise<void> } {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = tails.get(c.wa_id) ?? Promise.resolve()
    const finished = (async () => {
      try {
        if (shutdown.signal.aborted) {
          // Claimed when the shutdown came: nothing started.
          await queue.settle(c, 'pending', 'shutdown before the work started')
          log('message_released', { wamid: c.wamid })
          return
        }
        await work(c, release, previous)
      } catch (err) {
        log('process_crash', { wamid: c.wamid, error: errorText(err) }, 'error')
      } finally {
        release()
      }
    })()
    tails.set(c.wa_id, finished)
    void finished.then(() => {
      if (tails.get(c.wa_id) === finished) tails.delete(c.wa_id)
    })
    return { released, finished }
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p)
    p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    )
    return p
  }

  /**
   * One sender's lane: claim the oldest due row, work it up to its commit point, claim the next. A message reads its context before the
   * parse, so it must not start until the previous one has stored what it changed ("café 3500", then "uy, era 3800" must find the café).
   * A kick that finds the lane running asks it to look again. Resolves when the lane has nothing left and its replies are out.
   */
  function lane(waId: string): Promise<void> {
    const running = lanes.get(waId)
    if (running) {
      running.again = true
      return running.done
    }
    const state = { again: false, done: Promise.resolve() }
    state.done = (async () => {
      const finished: Promise<void>[] = []
      try {
        do {
          state.again = false
          while (!shutdown.signal.aborted) {
            const c = await queue.claimNext(waId)
            if (!c) break
            const job = start(c)
            finished.push(job.finished)
            await job.released
          }
        } while (state.again && !shutdown.signal.aborted)
      } catch (err) {
        log('lane_error', { wa_id: waId, error: errorText(err) }, 'error')
      } finally {
        lanes.delete(waId)
      }
      await Promise.all(finished)
    })()
    lanes.set(waId, state)
    return state.done
  }

  /**
   * The first signal on receipt: a message that waits behind an older one of its sender gets the read receipt and the typing indicator
   * now, not when its lane reaches it. Only for senders who get replies. Cosmetic: a failure is only logged.
   */
  async function firstSignal(senders: string[]): Promise<void> {
    await Promise.all(
      senders
        .filter((waId) => isAllowed(o.allowed, waId))
        .map(async (waId) => {
          const wamids = await queue.signalWaiting(waId)
          await Promise.all(
            wamids.map((wamid) =>
              graph
                .markReadAndType(wamid)
                .catch((err) => log('typing_failed', { wamid, error: errorText(err) })),
            ),
          )
        }),
    )
  }

  /** Claims and processes these senders' messages now, if they are due, and signals the ones that must wait. Never throws. */
  function kick(senders: string[]): Promise<void> {
    if (senders.length === 0 || shutdown.signal.aborted) return Promise.resolve()
    const unique = [...new Set(senders)]
    // The signal's UPDATE can hold a row a claim wanted for a moment (the claim skips locked rows): look at the lanes again after it.
    const signalled = firstSignal(unique)
      .catch((err) => log('typing_failed', { error: errorText(err) }))
      .then(() => Promise.all(unique.map(lane)))
    return track(
      Promise.all([...unique.map(lane), signalled]).then(
        () => {},
        (err) => log('kick_error', { error: errorText(err) }, 'error'),
      ),
    )
  }

  /** The recovery pass, and the only place housekeeping runs. Senders run in parallel. Skipped when the previous one is still running. */
  async function sweep(): Promise<number> {
    if (sweeping || shutdown.signal.aborted) return 0
    sweeping = true
    const done = track(
      (async () => {
        await queue.tidy()
        const senders = await queue.senders()
        await Promise.all(senders.map(lane))
        if (senders.length) log('sweep', { senders: senders.length })
        return senders.length
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
   * For SIGTERM: stop taking work, give back every message that is still parsing (it goes to `pending`, so the next process answers it
   * inside its deadline), then wait for sends in flight.
   */
  async function stop(ms: number): Promise<void> {
    shutdown.abort(new Error('shutdown'))
    await drain(ms)
  }

  return { kick, sweep, drain, stop }
}

export type Worker = ReturnType<typeof createWorker>
