import PostalMime, { decodeWords } from 'postal-mime'
import { parseDocument } from './parse/html'

/** Fewer mails than this and "the same text in every mail" says too little to trust. */
export const MIN_SKELETON_MAIL = 5

export class SkeletonError extends Error {}

/** The html part of a raw mail, or null when it has none. */
export async function htmlPart(raw: Uint8Array): Promise<string | null> {
  return (await PostalMime.parse(raw)).html ?? null
}

/** A signed Subject header as text, the way templates see it. */
export const decodeSubject = (subject: string) => decodeWords(subject).replace(/\s+/g, ' ').trim()

type Token = { kind: 'open' | 'close'; name: string } | { kind: 'text'; value: string }

type DomNode = {
  nodeType: number
  nodeName: string
  childNodes: Iterable<unknown>
  textContent: string | null
}

const SKIPPED = new Set(['SCRIPT', 'STYLE'])
const ELEMENT = 1
const TEXT = 3

/**
 * The document as a flat token list: tag names and text, in order. Attributes are dropped on
 * purpose (a href or src can carry ids), and so are comments, scripts and styles.
 */
function tokens(html: string): Token[] {
  const out: Token[] = []
  const walk = (node: DomNode) => {
    if (node.nodeType === TEXT) {
      const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (value) out.push({ kind: 'text', value })
    } else if (node.nodeType === ELEMENT && !SKIPPED.has(node.nodeName.toUpperCase())) {
      const name = node.nodeName.toLowerCase()
      out.push({ kind: 'open', name })
      for (const child of node.childNodes) walk(child as DomNode)
      out.push({ kind: 'close', name })
    }
  }
  const body = parseDocument(html).body
  if (body) walk(body as unknown as DomNode)
  return out
}

const MONEY =
  /(?:US\$|U\$S|\$|€|£|USD|ARS|EUR)\s*-?\d|\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?!\d)|\d+[.,]\d{2}(?!\d)/i
const DATETIME = /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\D{0,6}\d{1,2}:\d{2}/
const DATE = /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/
const DIGITS = /\d{3,}/

/** What a text node is, by shape alone: its value never survives. */
function shape(value: string): string {
  if (MONEY.test(value)) return '<money>'
  if (DATETIME.test(value)) return '<datetime>'
  if (DATE.test(value)) return '<date>'
  if (DIGITS.test(value)) return `<digits:${value.length}>`
  return `<text:${value.length}>`
}

const looksSensitive = (value: string) => !shape(value).startsWith('<text:')

/** Two mails share a layout when their tag and text-slot sequences are identical. */
const layoutKey = (list: Token[]) =>
  list
    .map((t) => (t.kind === 'text' ? '#' : `${t.kind === 'open' ? '<' : '</'}${t.name}`))
    .join(' ')

function render(group: Token[][]): string[] {
  const verbatimAllowed = group.length >= MIN_SKELETON_MAIL
  const lines: string[] = []
  let depth = 0
  ;(group[0] ?? []).forEach((token, i) => {
    const pad = '  '.repeat(token.kind === 'close' ? depth - 1 : depth)
    if (token.kind === 'text') {
      const constant = group.every((g) => (g[i] as { value: string }).value === token.value)
      const verbatim = verbatimAllowed && constant && !looksSensitive(token.value)
      lines.push(`${pad}${verbatim ? JSON.stringify(token.value) : shape(token.value)}`)
    } else if (token.kind === 'close') {
      depth--
      lines.push(`${pad}</${token.name}>`)
    } else {
      lines.push(`${pad}<${token.name}>`)
      depth++
    }
  })
  return lines
}

/**
 * Prints what the html parts of several mails have in common and nothing else. A text node
 * prints verbatim only when the same text sits at the same position in every mail of its
 * layout (and the layout has enough mails); every other node prints as a shape class. Money,
 * dates and runs of digits always print as their class, even when constant. Refuses fewer
 * than MIN_SKELETON_MAIL mails.
 */
export function skeleton(htmls: readonly string[]): string {
  if (htmls.length < MIN_SKELETON_MAIL) {
    throw new SkeletonError(`Need at least ${MIN_SKELETON_MAIL} mails, got ${htmls.length}.`)
  }
  const layouts = new Map<string, Token[][]>()
  for (const html of htmls) {
    const list = tokens(html)
    const key = layoutKey(list)
    layouts.set(key, [...(layouts.get(key) ?? []), list])
  }
  return [...layouts.values()]
    .sort((a, b) => b.length - a.length)
    .map((group, i) => [`layout ${i + 1}: ${group.length} mails`, ...render(group)].join('\n'))
    .join('\n\n')
}
