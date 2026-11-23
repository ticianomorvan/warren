import type { Call, Input } from '../core/commands'
import type { Sql } from '../core/db'
import {
  askLine,
  declineLine,
  describeFacts,
  describeReminders,
  forgetAllQuestion,
  REPLY,
  skipLine,
} from '../core/describe'
import { fitReply } from '../core/fit'
import type { Declined } from '../core/guards'
import type { Done, Question } from '../core/turn'
import { allLiveFacts } from '../domain/facts'
import { liveByIds } from '../domain/movements'
import { liveReminders } from '../domain/reminders/db'
import { runSummary } from '../domain/run-summary'

/**
 * The reply of a message, all of it rendered by code. A record, a total, a list, a question, a refusal and a part that was not done
 * come from `core/describe` over stored values and typed calls; free text exists only in `reply`, which goes alone, and is checked:
 * every number in it is one code gave, and it claims no change that Warren did not make (the window of earlier replies is the one
 * proof it may lean on). A text that fails is replaced by a short apology.
 */

/** Sent when the model's own words were thrown away (a number code did not give) and nothing else was to say. */
export const REPLY_SAY_FALLBACK =
  'Eso no te lo sé decir bien. Preguntame cuánto gastaste, o mandame un gasto o un ingreso y lo anoto.'

const REPLY_HELP =
  'Mandame un gasto o un ingreso y lo anoto. Por ejemplo: "café 3500 con la visa" o "cobré el sueldo 850.000".\nTambién te aviso de lo que me pidas: "recordame pagar la Visa el 10" o "todos los lunes recordame la pastilla". "¿Qué recordatorios tengo?" los lista, y pedime que cancele el que quieras o todos.'
const REPLY_HELP_DISCONNECT =
  'Si conectaste a Claude u otro agente y querés cortarle el acceso, escribime "desconectar".'

export interface HelpOptions {
  /** A human contact line for the help reply. */
  helpContact?: string
  /** Connecting an agent is on: the help says how to cut it. */
  disconnect?: boolean
}

/** The canned help text: the only reply the model does not write, for "ayuda" and greetings. */
export function renderHelp(o: HelpOptions = {}): string {
  const help = o.disconnect ? `${REPLY_HELP}\n${REPLY_HELP_DISCONNECT}` : REPLY_HELP
  return o.helpContact ? `${help}\nSi necesitás hablar con una persona: ${o.helpContact}` : help
}

// ---- Rendering what code says that is not a write

/** What code rendered for a call that is not a write, read before the commit (a list, a total, a question). */
export interface Rendered {
  lines: string[]
  question?: Question
}

/**
 * Renders the calls whose answer needs a read and no write: totals, lists, the options of a question. Run before `commit`, outside
 * its transaction: they read what the person has, and nothing about them changes what the commit writes.
 */
export async function render(
  sql: Sql,
  accountId: number,
  calls: readonly Call[],
  today: string,
  help: HelpOptions = {},
): Promise<Map<Call, Rendered>> {
  const out = new Map<Call, Rendered>()
  let asked = false
  for (const call of calls) {
    switch (call.tool) {
      case 'summarize':
        out.set(call, { lines: (await runSummary(sql, accountId, call.input, today)).lines })
        break
      case 'list_facts':
        out.set(call, { lines: [describeFacts(await allLiveFacts(sql, accountId))] })
        break
      case 'list_reminders':
        out.set(call, { lines: [describeReminders(await liveReminders(sql, accountId), today)] })
        break
      case 'forget_all_facts': {
        // Code asks, and only the person's "sí" forgets: nothing is forgotten here.
        const known = await allLiveFacts(sql, accountId)
        out.set(
          call,
          known.length === 0
            ? { lines: [describeFacts([])] }
            : {
                lines: [forgetAllQuestion(known.length)],
                question: { options: [], then: { do: 'forget_all' } },
              },
        )
        break
      }
      case 'ask_user': {
        const a: Input<'ask_user'> = call.input
        // Only the person's live movements are offered, newest first, however the model ordered them.
        const options = await liveByIds(sql, accountId, a.movement_ids)
        const question: Question | undefined =
          !asked && options.length > 0
            ? {
                options: options.map((m, k) => ({ n: k + 1, id: m.id, v: m.version })),
                then: a.then,
              }
            : undefined
        asked ||= question !== undefined
        out.set(call, {
          lines: [askLine(options, a.then, today)],
          ...(question ? { question } : {}),
        })
        break
      }
      case 'skip':
        out.set(call, { lines: [skipLine(call.input.part, call.input.reason)] })
        break
      case 'help':
        out.set(call, { lines: [renderHelp(help)] })
        break
    }
  }
  return out
}

export interface ComposeInput {
  rendered: ReadonlyMap<Call, Rendered>
  declined: readonly Declined[]
  /** What was heard in a voice note: a reply with no record of a change starts with it, rendered by code. */
  heard?: string
  /** The message held something Warren must not keep: no word of the model's and no transcript in the reply. */
  redact?: boolean
}

/**
 * The one reply of a turn, from what the commit did: each call's line in order (a write's from `describe`, the rest from `render`),
 * then what code declined, then the model's `reply` when it passes `checkReply`. The text never stands beside a record.
 */
export function compose(
  i: ComposeInput,
  done: readonly Done[],
  record: string | null,
): { reply: string; question: Question | null } {
  const lines: string[] = []
  let question: Question | null = null
  const say = (line: string) => {
    if (!lines.includes(line)) lines.push(line)
  }
  for (const d of done) {
    const { call } = d
    if (d.line !== null) {
      lines.push(d.line)
      continue
    }
    if (call.tool === 'reply') {
      if (i.redact) say(REPLY.factSecret)
      else {
        // The verdict the turn's guards gave these words: a text that failed it on the last turn is replaced by the apology.
        const verdict = call.verdict
        say(verdict?.ok ? verdict.text : REPLY_SAY_FALLBACK)
      }
      continue
    }
    const r = i.rendered.get(call)
    if (r) lines.push(...r.lines)
    question ??= r?.question ?? null
  }
  for (const code of i.declined) say(declineLine(code))
  if (lines.length === 0) lines.push(REPLY_SAY_FALLBACK)
  return {
    reply: fitReply({
      heard: i.redact || record !== null ? undefined : i.heard,
      lines,
      notes: [],
    }),
    question,
  }
}
