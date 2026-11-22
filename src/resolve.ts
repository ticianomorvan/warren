import type { Action, Pending } from './agent'
import { normalizeText } from './movement'

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

/** The options a question offered, with what choosing one will do. */
export interface PendingQuestion {
  asked: { number: number; id: number }[]
  pending: Pending | null
}

/**
 * The action a message is, when it is only the answer to the question we just asked ("2", "el
 * primero", "sí"): the pending correction or deletion, aimed at the movement that option offered,
 * by its id (the list may have shifted since). Code does this, never the model, so a short answer
 * cannot be read as something else.
 */
export function answerAction(text: string, question: PendingQuestion | null): Action | null {
  if (!question) return null
  // "¿Conectar …?" over a sign-in: only a bare "sí" confirms and only a bare "no" declines. Anything else is not an answer
  // to it: the sign-in stays as it is and the message goes on to the agent.
  if (question.pending?.action === 'link') {
    const { link_id } = question.pending
    const norm = normalizeText(text)
    if (LINK_YES.test(norm)) return { tool: 'link_confirm', input: { link_id } }
    return NO.test(norm) ? { tool: 'link_decline', input: { link_id } } : null
  }
  // "¿Seguro?" over forgetting everything: only a yes is an answer (never "1", "ese" or "el primero"), and nothing else is read as one.
  if (question.pending?.action === 'forget_all') {
    return YES.test(normalizeText(text)) ? { tool: 'forget_all_confirmed', input: {} } : null
  }
  const n = answerNumber(
    text,
    question.asked.map((a) => a.number),
  )
  const id = question.asked.find((a) => a.number === n)?.id
  if (id === undefined) return null
  // A question with nothing behind it ("¿Qué querés cambiar?" over several options): the number picks one,
  // and the follow-up is about that movement alone. (Code asks it, so the options are not listed again.)
  if (!question.pending) {
    // One option left: only "sí" or "ese" asks again about it (never other movements); a bare "1" goes to the model.
    const again = question.asked.length === 1 && /^[^\d]+$/.test(normalizeText(text))
    return question.asked.length > 1 || again
      ? {
          tool: 'ask_user',
          input: { question: 'Qué querés cambiar', movement_ids: [id], after_answer: 'none' },
        }
      : null
  }
  return question.pending.action === 'delete'
    ? { tool: 'delete_movement', input: { id, text: null } }
    : { tool: 'correct_movement', input: { id, changes: question.pending.changes, text: null } }
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
export function undoRequest(text: string): Action | null {
  const words = normalizeText(text)
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return UNDO.test(words) ? { tool: 'undo_last', input: { text: null } } : null
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
export function disconnectRequest(text: string): Action | null {
  const words = normalizeText(text)
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return DISCONNECT.test(words) ? { tool: 'mcp_disconnect', input: {} } : null
}

const BAJA =
  /^(?:(?:por favor|porfa)\s+)?(?:quiero\s+)?(?:(?:la\s+)?baja|(?:dar(?:me)?|dame)\s+de\s+baja)(?:\s+(?:por favor|porfa))?$/

/**
 * "BAJA" (also "baja", "dame de baja", "quiero la baja"): a typed message that is only that stops every reminder, done by code
 * with no model call (Meta's policy asks for an opt-out that is honoured as written, and the template tells the person to
 * send it). Anything with more in it ("baja el precio", "dar de baja la visa") is not, and goes to the model.
 */
export function bajaRequest(text: string): Action | null {
  const words = normalizeText(text)
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return BAJA.test(words) ? { tool: 'cancel_all_reminders', input: {} } : null
}
