/**
 * Guards 4 and 5, as pure functions: what reaches the person is the model's text with every number
 * checked against what code gave it, plus every change's code-rendered line.
 */

/** A number as written in Argentine text ("3.500", "1.500,50"), in a tool result ("1500.50") or plain, as one comparable string. */
export function normalizeNumber(token: string): string {
  let t = token
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '')
  t = t.replace(',', '.')
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '')
  return t.replace(/^0+(?=\d)/, '')
}

/** Every number in a text. A thousands group ("3.500") is one number; a date or a clock gives its parts. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g) ?? []).map(normalizeNumber)
}

/**
 * The numbers of `text` that no fact has. A line number that starts a line ("1. Café", "2) Súper") is a
 * list label, not a figure, and is not checked.
 */
export function unknownNumbers(text: string, facts: string[]): string[] {
  const known = new Set(facts.flatMap(numbersIn))
  const labels = text.replace(/^\s*\d{1,2}[.)]\s/gm, '')
  return [...new Set(numbersIn(labels).filter((n) => !known.has(n)))]
}

export const FALLBACK_TEXT = 'No pude armar la respuesta. Probá de nuevo con otras palabras.'

export interface Finalized {
  text: string
  /** The model's text was replaced: these numbers were nowhere in what code gave it. */
  replaced: boolean
  unknown: string[]
}

/**
 * The reply: the lines code rendered for this turn's actions, then the model's text. A line the model
 * already copied is not shown twice. If the model's text holds a number no fact has, only the lines
 * remain (or the fallback when there are none).
 */
export function finalize(o: { modelText: string; lines: string[]; facts: string[] }): Finalized {
  const model = o.modelText.trim()
  const unknown = unknownNumbers(model, [...o.facts, ...o.lines])
  const replaced = unknown.length > 0
  const kept = replaced ? '' : model
  const lines = o.lines.filter((l) => !kept.includes(l.trim()))
  const parts = [...lines, ...(kept ? [kept] : [])]
  if (parts.length === 0) return { text: replaced ? FALLBACK_TEXT : '', replaced, unknown }
  return { text: parts.join('\n'), replaced, unknown }
}
