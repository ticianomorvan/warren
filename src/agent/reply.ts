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
import { fold, hasForeignDigit, NUMBER_WORD_RE, tokens } from '../core/numbers'
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

export const MAX_REPLY_TEXT = 280

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

/**
 * A first-person past claim ("borré", "corregí", "anoté", "listo") is true only if this message did that.
 * `window` is the one other proof: a `reply` that answers about earlier work ("¿borraste el super?" "Sí, lo
 * borré") may lean on what Warren answered before, read from those replies' own wording (`✓ Borré`,
 * `✓ Corregido`, `✓`). That is a wording dependency on render.ts, kept to `reply` and covered by tests; the
 * risk is that an old line proves a claim about a thing it did not do (the same word, another movement).
 */
const NOT = '(?<!\\bno )(?<!\\bno lo )(?<!\\bno te )'
const CLAIMS: {
  said: RegExp
  window: RegExp
  what: string
}[] = [
  {
    said: new RegExp(`${NOT}\\b(?:borre|elimine|saque)\\b`),
    window: /\bborre\b/,
    what: 'a deletion',
  },
  {
    said: new RegExp(`${NOT}\\b(?:corregi|cambie|modifique|actualice)\\b`),
    window: /\bcorregido\b/,
    what: 'a correction',
  },
  {
    said: new RegExp(`${NOT}\\b(?:anote|registre|agregue|guarde)\\b`),
    window: /✓ (?!borre\b|corregido\b)|🧠 me acuerdo/,
    what: 'a new movement or fact',
  },
  {
    // "Anotado como dato: ...", "Tomo nota": a reply that opens by saying it took note. Only a log or a stored fact makes that
    // true. Only at the start of a sentence: "la nafta fue $20.000, anotada hoy" describes what is stored.
    said: /(?:^|[.!?:] ?)(?:anotado|anotada|guardado|guardada|tomo nota|tome nota)\b/,
    window: /✓ (?!borre\b|corregido\b)|🧠 me acuerdo/,
    what: 'a note taken',
  },
  {
    said: new RegExp(`${NOT}\\b(?:me acuerdo|me acorde|ya lo recuerdo|lo recordare)\\b`),
    window: /🧠 me acuerdo/,
    what: 'a fact remembered',
  },
  {
    said: new RegExp(`${NOT}\\b(?:me olvide|olvide)\\b`),
    window: /🧠 me olvide/,
    what: 'a fact forgotten',
  },
  {
    // "Te aviso", "programé": only a reminder that code set makes that true ("¿me vas a avisar?" is a question, not this).
    said: new RegExp(`${NOT}\\b(?:programe|agende|te aviso|te voy a avisar)\\b`),
    window: /⏰ te aviso/,
    what: 'a reminder set',
  },
  {
    // "¿Cuál querés que cancele?" is a question, not a claim: accent-stripped it reads like "cancelé".
    said: new RegExp(`${NOT}(?<!\\bque )\\bcancele\\b`),
    window: /⏰ cancele/,
    what: 'a reminder cancelled',
  },
  {
    said: new RegExp(`${NOT}\\b(?:deshice|anule|reverti|volvi atras)\\b`),
    window: /↩/,
    what: 'an undo',
  },
  {
    said: /\b(?:listo|hecho|ya esta|quedo en|ahora (?:es|esta|figura|queda))\b/,
    window: /✓/,
    what: 'a change',
  },
]

/** One line, single spaces. */
export const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Whether `phrase` appears in `source` on its own: not as the tail of a longer number ("12 lucas" does not
 * hold "2 lucas") .
 */
const holds = (source: string, phrase: string) => {
  for (let at = source.indexOf(phrase); at >= 0; at = source.indexOf(phrase, at + 1)) {
    if (!/[\d.,]/.test(source[at - 1] ?? '')) return true
  }
  return false
}

/** ISO days are numbers of their own (the dashes are theirs): leave them out before looking for other dashes. */
const withoutDays = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}/g, ' ')

/**
 * Pieces of a figure that are each given but make a new one when put together: a number with a multiplier
 * ("2 lucas"), digits split by a space ("12 500"), a minus or a range ("-3500", "3500-4000"), a percent.
 * Each must appear in a source exactly as it is written in the text.
 */
const MADE_OF_PIECES = [
  /\d+(?:[.,]\d+)?\s*(?:mil|lucas?|lukas?|palos?|millon(?:es)?|k|m)\b/g,
  /(?<!\d)(?<!\d[.,])\d{1,3}(?: \d{3})+(?!\d|[.,]\d)/g,
  /(?<![\p{L}\d])-\s*\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s*-\s*\d+(?:[.,]\d+)*/gu,
  /\d+(?:[.,]\d+)*\s*%|%/g,
]

export type ReplyCheck = { ok: true; text: string } | { ok: false; reason: string }

/** What a reply may lean on. */
export interface Evidence {
  /** Where numbers may come from: the person's message, the context and what searches found. */
  numbers: readonly string[]
  /** Where number words may come from: the person's side only (never the model's own descriptions). */
  words: readonly string[]
  /** What Warren answered earlier: the proof of a claim of a change. */
  window: readonly string[]
}

/**
 * Whether `text` may be sent as a `reply`: short, not shaped like a code-rendered record (`✓ ...`), with no number that code did not
 * give, no figure made of given pieces, and no claim of a change this message did not make (a reply is alone, so only an earlier
 * reply can prove one). The reason of a refusal names the first offence, for the audit.
 */
export function checkReply(text: string, e: Evidence): ReplyCheck {
  const one = squash(text.normalize('NFKC'))
  if (hasForeignDigit(text)) return { ok: false, reason: 'digits that are not 0-9' }
  if (one === '') return { ok: false, reason: 'empty' }
  if (one.length > MAX_REPLY_TEXT)
    return { ok: false, reason: `longer than ${MAX_REPLY_TEXT} characters` }
  if (one.includes('✓') || one.includes('↩') || one.includes('🧠')) {
    return { ok: false, reason: 'imitates a code-rendered line (✓, ↩︎, 🧠)' }
  }
  const known = new Set(e.numbers.flatMap((s) => tokens(s).flatMap((t) => t.provides)))
  const unknown = tokens(one).filter((t) => !known.has(t.needs))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `number not given by code: ${[...new Set(unknown.map((t) => t.written))].join(', ')}`,
    }
  }
  // "2 lucas" is 2000 whatever 2 and "lucas" were given separately: the whole phrase must be given.
  const given = e.numbers.map((src) => fold(withoutDays(squash(src.normalize('NFKC')))))
  const mine = fold(withoutDays(one))
  for (const re of MADE_OF_PIECES) {
    const made = (mine.match(re) ?? []).filter((phrase) => !given.some((src) => holds(src, phrase)))
    if (made.length > 0) {
      return { ok: false, reason: `figure made of given pieces: ${made.join(', ')}` }
    }
  }
  const proof = e.window.map((src) => fold(src))
  for (const claim of CLAIMS) {
    const word = claim.said.exec(mine)?.[0]
    if (word && !proof.some((src) => claim.window.test(src))) {
      return { ok: false, reason: `claims ${claim.what} this message did not make: ${word}` }
    }
  }
  const spelled = new Set(e.words.flatMap((s) => fold(s).match(NUMBER_WORD_RE) ?? []))
  const words = [...new Set(mine.match(NUMBER_WORD_RE) ?? [])].filter((w) => !spelled.has(w))
  if (words.length > 0) {
    return { ok: false, reason: `number written in words not given by code: ${words.join(', ')}` }
  }
  return { ok: true, text: one }
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
  evidence: Evidence
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
        const checked = checkReply(call.input.text, i.evidence)
        say(checked.ok ? checked.text : REPLY_SAY_FALLBACK)
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
