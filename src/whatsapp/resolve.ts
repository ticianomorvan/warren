import type { Call } from '../core/commands'
import type { Question } from '../core/turn'
import { normalizeText } from '../core/values'

const NUMBER_WORDS: Record<string, number> = {
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
}

const SHAPE =
  /^(?:(?:dale|bueno|ok|si)[,\s]+)?(?:(?:el|la|lo|numero|nro)\s*|#\s*)?(\d{1,2}|[a-z]+)\s*[.!]?$/
const YES = /^(?:(?:si|dale|ok|bueno)[,\s]*)+[.!]?$/
const NO = /^(?:(?:no|nop|nope)[,\s]*)+(?:gracias)?[.!]?$/
/** "ese", "ese mismo", "sí, ese": pointing at the one movement the question offered. */
const THAT_ONE =
  /^(?:(?:si|dale|ok|bueno)[,\s]+)?(?:ese|esa|eso|el mismo|la misma|ese mismo|esa misma|ese nomas|esa nomas)[.!]?$/
const ORDINAL_INDEX: [RegExp, number][] = [
  [/^primer[oa]?$/, 0],
  [/^segund[oa]$/, 1],
  [/^tercer[oa]?$/, 2],
  [/^cuart[oa]$/, 3],
]

/**
 * Which of the options of a `¿Cuál?` question (`asked`: the list numbers it showed, in order) a
 * message picks, when the message is only that answer: "2", "el 2", "la tres", "el primero" /
 * "la segunda" (the first, second… option shown, not list rows), "el último" (row 1), or "sí" /
 * "dale" / "sí, dale" after a one-option question. Anything with more in it (a change, a
 * description) is not an answer.
 */
export function answerNumber(text: string, asked: number[]): number | null {
  const norm = normalizeText(text)
  if (YES.test(norm) || THAT_ONE.test(norm)) return asked.length === 1 ? (asked[0] ?? null) : null
  const token = SHAPE.exec(norm)?.[1]
  if (token === undefined) return null
  const ordinal = ORDINAL_INDEX.find(([re]) => re.test(token))
  const n = /^\d+$/.test(token)
    ? Number(token)
    : ordinal
      ? asked[ordinal[1]]
      : /^ultim[oa]$/.test(token)
        ? 1
        : NUMBER_WORDS[token]
  return n !== undefined && asked.includes(n) ? n : null
}

/**
 * What a message that is only the answer to a question, or only a command code owns, comes to. Pure: the one function the worker asks
 * before it asks the model. A `call` goes through `commit` like the model's own; link and disconnect are the worker's (they have no
 * registry tool: they are not the person's ledger).
 */
export type CodeAnswer =
  | { kind: 'call'; call: Call }
  | { kind: 'link_ask'; code: string }
  | { kind: 'link_confirm'; linkId: number }
  | { kind: 'link_decline'; linkId: number }
  | { kind: 'disconnect' }

export interface AnswerContext {
  /** The question Warren's newest turn asked, if it is recent enough to be answered (`turn.question`). */
  question: Question | null
  /** The message is typed text: never a voice note's transcript or a photo's caption. A delete, a correction or an undo is never run on what a model of speech thought it heard. */
  typed: boolean
  /** Connecting an agent over MCP is on: "vincular <code>", the "sí" to its question and "desconectar". */
  signIn: boolean
}

/**
 * The answer code gives with no model call, or null when the message goes on to the agent:
 *  1. "vincular <code>" comes first, whatever else is open (typed text only, like every answer code gives);
 *  2. a bare answer to the question we asked ("2", "el primero", "sí"): the pending correction or deletion, aimed at the movement that
 *     option offered, by its id (the list may have shifted since); "¿Seguro?" over forgetting everything takes only a yes; a sign-in's
 *     question takes only a bare "sí" or "no";
 *  3. with no question open: a bare "deshacer", and "desconectar" where connecting is on. A "deshacer" while a question is open most
 *     likely means "never mind", not "undo the batch before": the model reads it.
 */
export function codeAnswer(text: string, c: AnswerContext): CodeAnswer | null {
  if (!c.typed) return null
  const code = c.signIn ? linkCode(text) : null
  if (code) return { kind: 'link_ask', code }
  if (c.question) return answerQuestion(text, c.question)
  if (undoRequest(text)) return { kind: 'call', call: { tool: 'undo_last', input: {} } }
  return c.signIn && disconnectRequest(text) ? { kind: 'disconnect' } : null
}

function answerQuestion(text: string, question: Question): CodeAnswer | null {
  const then = question.then
  const norm = normalizeText(text)
  // "¿Conectar …?" over a sign-in: only a bare "sí" confirms and only a bare "no" declines. Anything else is not an answer
  // to it: the sign-in stays as it is and the message goes on to the agent.
  if (then.do === 'link') {
    if (LINK_YES.test(norm)) return { kind: 'link_confirm', linkId: then.link_id }
    return NO.test(norm) ? { kind: 'link_decline', linkId: then.link_id } : null
  }
  // "¿Seguro?" over forgetting everything: only a yes is an answer (never "1", "ese" or "el primero").
  if (then.do === 'forget_all') {
    return YES.test(norm)
      ? { kind: 'call', call: { tool: 'forget_all_confirmed', input: {} } }
      : null
  }
  const n = answerNumber(
    text,
    question.options.map((o) => o.n),
  )
  const id = question.options.find((o) => o.n === n)?.id
  if (id === undefined) return null
  switch (then.do) {
    case 'delete':
      return { kind: 'call', call: { tool: 'delete_movement', input: { id } } }
    case 'correct':
      return {
        kind: 'call',
        call: { tool: 'correct_movement', input: { id, changes: then.changes } },
      }
    case 'ask_change': {
      // A question with nothing behind it ("¿Qué querés cambiar?" over several options): the number picks one, and the follow-up
      // is about that movement alone. One option left: only "sí" or "ese" asks again about it (never other movements);
      // a bare "1" goes to the model.
      const again = question.options.length === 1 && /^[^\d]+$/.test(norm)
      return question.options.length > 1 || again
        ? { kind: 'call', call: { tool: 'ask_user', input: { movement_ids: [id], then } } }
        : null
    }
  }
}

const UNDO_VERB =
  '(?:deshac(?:e|er|elo)|anul(?:a|ar|alo)|revert(?:i|ir|ilo)|volver? atras|vuelve atras)'
/**
 * What an undo may point at: the last thing, never one named movement ("deshacé el café", "el último", which names
 * one movement while a batch may hold several) and never "todo". No "no"/"mejor" before the verb: "no deshacer" and
 * "mejor no anular" are the opposite of an undo, and "no, deshacelo" goes to the model, which reads the conversation.
 */
const UNDO_OBJECT =
  '(?:eso|esto|lo|lo ultimo|lo anterior|lo que (?:hiciste|hice|anotaste|puse|acabas de hacer|acabo de hacer)|lo ultimo que (?:hiciste|hice|anotaste|puse))'
const UNDO = new RegExp(
  `^(?:(?:ay|uy|ups|dale|bueno|perdon|ok)\\s+)*(?:(?:por favor|porfa)\\s+)?${UNDO_VERB}(?:\\s+${UNDO_OBJECT})?(?:\\s+(?:por favor|porfa|nomas))?$`,
)

/**
 * "deshacer", "deshacé lo último", "volvé atrás", "anulá lo que hiciste": a typed message that is only that is
 * the undo of the last batch, done by code with no model call. Anything with more in it, or that names one
 * movement ("deshacé el café", "deshacer todo"), is not, and goes to the model.
 */
export function undoRequest(text: string): boolean {
  const words = normalizeText(text)
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return UNDO.test(words)
}

const LINK_REQUEST = /^vincul(?:ar|a)\s+([a-z0-9]{6})[.!]?$/
/** Only a plain "sí" connects an agent: not "ok", "dale" or "bueno", which a stray answer to something else may be. */
const LINK_YES = /^si[.!]?$/

/**
 * "vincular K7M2QX": a typed message that is only that is the code a browser showed (the `wa.me` link
 * writes it), uppercased the way it is stored. Anything else with a code in it is not one.
 */
export function linkCode(text: string): string | null {
  const code = LINK_REQUEST.exec(normalizeText(text).replace(/\s+/g, ' '))?.[1]
  return code ? code.toUpperCase() : null
}

const DISCONNECT =
  /^(?:(?:por favor|porfa)\s+)?desconect(?:ar|a|ame|alo|alos)(?:\s+(?:a\s+)?(?:claude|todo|todos|la conexion|las conexiones))?(?:\s+(?:por favor|porfa|nomas))?$/

/**
 * "desconectar", "desconectá a Claude", "desconectar todo": a typed message that is only that cuts every connection of an agent
 * (docs/mcp-spec.md, Slice 3), done by code with no model call, like `undoRequest`. Anything with more in it goes to the model.
 */
export function disconnectRequest(text: string): boolean {
  const words = normalizeText(text)
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return DISCONNECT.test(words)
}
