import PostalMime, { decodeWords } from 'postal-mime'
import { parseDocument } from './parse/html'

/** Fewer distinct mails than this and "the same text in every mail" says too little to trust. */
export const MIN_SKELETON_MAIL = 5

/** Fixed on purpose: it must not say how many mails there were (that would be an oracle). */
export const SKELETON_REFUSAL = 'Not enough distinct mail to print a skeleton.'

export class SkeletonError extends Error {}

/** The html part of a raw mail, or null when it has none. */
export async function htmlPart(raw: Uint8Array): Promise<string | null> {
  return (await PostalMime.parse(raw)).html ?? null
}

/** A signed Subject header as text, the way templates see it. */
export const decodeSubject = (subject: string) => decodeWords(subject).replace(/\s+/g, ' ').trim()

/** Lower case, without accents. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * Tokens to keep out of the output, from values that identify the user (addresses, name):
 * each value whole, and its parts split on anything that is not a letter or digit, when a part
 * is at least 3 characters.
 */
export function forbiddenTokens(values: readonly string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    const whole = fold(value).trim()
    if (whole.length >= 3) out.add(whole)
    for (const part of whole.split(/[^\p{L}\p{N}]+/u)) if (part.length >= 3) out.add(part)
  }
  return [...out]
}

type Token = { kind: 'open' | 'close' | 'void'; name: string } | { kind: 'text'; value: string }

type DomNode = {
  nodeType: number
  nodeName: string
  childNodes: Iterable<unknown>
  textContent: string | null
}

const SKIPPED = new Set(['SCRIPT', 'STYLE'])
const VOID = new Set(['BR', 'IMG', 'HR', 'INPUT', 'META', 'WBR'])
const ELEMENT = 1
const TEXT = 3

/**
 * The visible content of an html part, so that it always parses into `<body>`: head and title
 * are removed, and so are the html and body wrappers, then the rest is put into a fresh body.
 */
function bodyOf(html: string) {
  const content = html
    .replace(/<head[\s>][\s\S]*?<\/head\s*>/gi, '')
    .replace(/<title[\s>][\s\S]*?<\/title\s*>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(?:html|body|head)(?:\s[^>]*)?>/gi, '')
  return parseDocument(`<html><body>${content}</body></html>`).body
}

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
      if (VOID.has(node.nodeName.toUpperCase())) {
        out.push({ kind: 'void', name })
        return
      }
      out.push({ kind: 'open', name })
      for (const child of node.childNodes) walk(child as DomNode)
      out.push({ kind: 'close', name })
    }
  }
  const body = bodyOf(html)
  if (body) walk(body as unknown as DomNode)
  return out
}

const CURRENCY = '(?:US\\$|U\\$S|\\$|€|£|USD|ARS|EUR)'
const MONEY = new RegExp(
  `${CURRENCY}\\s*-?\\d|\\d[\\d.,]*\\s*${CURRENCY}(?![\\p{L}])|\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2}(?!\\d)|\\d+[.,]\\d{2}(?!\\d)`,
  'iu',
)
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

const isTextClass = (value: string) => shape(value).startsWith('<text:')

const layoutKey = (list: Token[]) =>
  list
    .map((t) => (t.kind === 'text' ? '#' : `${t.kind === 'close' ? '</' : '<'}${t.name}`))
    .join(' ')

const valuesKey = (list: Token[]) =>
  list.map((t) => (t.kind === 'text' ? t.value : '')).join('\u0000')

function render(group: Token[][], forbidden: readonly string[]): string[] {
  const first = group[0] ?? []
  const column = (i: number) => group.map((g) => (g[i] as { value: string }).value)
  // With too few distinct mails, or when no text slot ever varies, labels cannot be told from
  // values, so nothing prints verbatim.
  const trusted =
    group.length >= MIN_SKELETON_MAIL &&
    first.some(
      (token, i) =>
        token.kind === 'text' &&
        column(i).some((v) => v !== token.value) &&
        column(i).some(isTextClass),
    )
  const lines: string[] = []
  let depth = 0
  first.forEach((token, i) => {
    const pad = '  '.repeat(token.kind === 'close' ? depth - 1 : depth)
    if (token.kind === 'text') {
      const folded = fold(token.value)
      const verbatim =
        trusted &&
        column(i).every((v) => v === token.value) &&
        !/[\d@]/.test(token.value) &&
        !forbidden.some((f) => folded.includes(f))
      lines.push(`${pad}${verbatim ? JSON.stringify(token.value) : shape(token.value)}`)
    } else if (token.kind === 'close') {
      depth--
      lines.push(`${pad}</${token.name}>`)
    } else {
      lines.push(`${pad}<${token.name}>`)
      if (token.kind === 'open') depth++
    }
  })
  return lines
}

/**
 * Prints what the html parts of several mails have in common and nothing else. A text node
 * prints verbatim only when the same text sits at the same position in every mail of its
 * layout, the layout has at least MIN_SKELETON_MAIL distinct mails, some text slot of the
 * layout varies, and the text has no digit, no `@` and no forbidden token. Every other node
 * prints as a shape class. Mails with the same text values count once. Refuses, with a message
 * that does not say how many, when fewer than MIN_SKELETON_MAIL distinct mails are given.
 */
export function skeleton(
  htmls: readonly string[],
  options: { forbidden?: readonly string[] } = {},
): string {
  const forbidden = (options.forbidden ?? []).map(fold).filter((f) => f.length >= 3)
  const distinct = new Map<string, Token[]>()
  for (const html of htmls) {
    const list = tokens(html)
    distinct.set(`${layoutKey(list)}\u0001${valuesKey(list)}`, list)
  }
  if (distinct.size < MIN_SKELETON_MAIL) throw new SkeletonError(SKELETON_REFUSAL)
  const layouts = new Map<string, Token[][]>()
  for (const list of distinct.values()) {
    const key = layoutKey(list)
    layouts.set(key, [...(layouts.get(key) ?? []), list])
  }
  return [...layouts.values()]
    .sort((a, b) => b.length - a.length)
    .map((group, i) => {
      const counted = group.length >= MIN_SKELETON_MAIL ? `: ${group.length} mails` : ''
      return [`layout ${i + 1}${counted}`, ...render(group, forbidden)].join('\n')
    })
    .join('\n\n')
}
