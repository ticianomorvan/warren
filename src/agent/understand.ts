import type Anthropic from '@anthropic-ai/sdk'
import type { Call } from '../core/commands'
import type { Sql } from '../core/db'
import type { Declined } from '../core/guards'
import { sensitive } from '../core/secrets'
import type { Done, Question } from '../core/turn'
import { findMovements } from '../domain/movements'
import { argentinaToday } from '../time'
import type { TurnTiming } from '../timings'
import { contextInput, type Read, readState, renderContext, withFound } from './context'
import { type AgentResult, type AuditEntry, type Photo, runAgent } from './loop'
import type { ModelKey, Usage } from './models'
import { checkReply, compose, type HelpOptions, render } from './reply'

/**
 * A message through the agent, to the calls handed to `core/turn.commit`: reads the person's state, renders the context the model
 * is shown, runs the loop, renders what code answers beside the writes, and hands back a `compose` that builds the reply from what
 * the commit did. Nothing is written here.
 */

export interface UnderstandInput {
  sql: Sql
  client: Anthropic
  model?: ModelKey
  accountId: number
  /** The person's message, or what was heard in a voice note. */
  text: string
  /** The message's own time: the day, the conversation window and the turn's `created_at`. */
  at: Date
  /** The instant a reminder is judged against: `at`, or later if the message waited. Default `at`. */
  now?: Date
  photo?: Photo
  /** The text is the transcript of a voice note: the model is told it can be misheard, and the reply may start with it. */
  voice?: boolean
  help?: HelpOptions
  signal?: AbortSignal
  deadlineAt?: number
  /** The state already read (a worker that reads it beside the media download). */
  read?: Read
}

export interface Understood {
  /** Handed to `commit` as `calls`. */
  calls: Call[]
  /** Handed to `commit` as `compose`. */
  compose: (done: Done[], record: string | null) => { reply: string; question?: Question | null }
  /** The message held a secret (or the model tried to store one): `commit` is told to keep no input (`scrub`). */
  redact: boolean
  declined: Declined[]
  audit: AuditEntry[]
  turns: number
  usage: Usage
  turnLog: TurnTiming[]
  /** Wall time of the model loop, reads included. */
  ms: number
}

export async function understand(i: UnderstandInput): Promise<Understood> {
  const today = argentinaToday(i.at)
  const read = i.read ?? (await readState(i.sql, i.accountId, i.at, i.text))
  const ctx = renderContext(
    contextInput(read, {
      text: i.text,
      at: i.at,
      ...(i.photo ? { photo: true } : {}),
      ...(i.voice ? { voice: true } : {}),
    }),
  )
  const result: AgentResult = await runAgent({
    client: i.client,
    ...(i.model ? { model: i.model } : {}),
    context: ctx.text,
    ...(i.photo ? { photo: i.photo } : {}),
    shown: ctx.shown,
    message: i.text,
    today,
    now: i.now ?? i.at,
    env: { find: (filter) => findMovements(i.sql, i.accountId, filter) },
    vet: (text, found) => {
      const seen = withFound(ctx, found)
      const checked = checkReply(text, {
        numbers: seen.evidence,
        words: seen.evidence,
        window: seen.window,
      })
      return checked.ok ? null : checked.reason
    },
    ...(i.signal ? { signal: i.signal } : {}),
    ...(i.deadlineAt !== undefined ? { deadlineAt: i.deadlineAt } : {}),
  })
  const rendered = await render(i.sql, i.accountId, result.calls, today, i.help)
  const redact = sensitive(i.text) || result.declined.includes('secret')
  const seen = withFound(ctx, result.found)
  return {
    calls: result.calls,
    compose: (done, record) =>
      compose(
        {
          rendered,
          declined: result.declined,
          evidence: { numbers: seen.evidence, words: seen.evidence, window: seen.window },
          ...(i.voice ? { heard: i.text } : {}),
          redact,
        },
        done,
        record,
      ),
    redact,
    declined: result.declined,
    audit: result.audit,
    turns: result.turns,
    usage: result.usage,
    turnLog: result.turnLog,
    ms: result.ms,
  }
}
