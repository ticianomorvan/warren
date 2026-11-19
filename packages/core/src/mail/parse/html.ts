import { parseHTML } from 'linkedom'
import { FieldError } from './fields'

export type Doc = ReturnType<typeof parseHTML>['document']

export function parseDocument(html: string): Doc {
  return parseHTML(html).document
}

const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'BR',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'TR',
  'UL',
])

/** All the text of the document, whitespace collapsed, with a space where a block begins or ends. */
export function bodyText(doc: Doc): string {
  const parts: string[] = []
  const walk = (node: Doc | Doc['documentElement']) => {
    if (node.nodeType === 3) parts.push(node.textContent ?? '')
    const block = node.nodeType === 1 && BLOCKS.has((node as Doc['documentElement']).tagName)
    if (block) parts.push(' ')
    for (const child of node.childNodes) walk(child as typeof node)
    if (block) parts.push(' ')
  }
  walk(doc.documentElement)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Reads every row in the document shaped as [label cell, value cell]. Rows that hold a nested
 * table are layout wrappers and are skipped. A repeated label is a layout change, so it throws.
 */
export function labelValueRows(doc: Doc): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of doc.querySelectorAll('tr')) {
    const cells = [...row.children].filter((c) => c.tagName === 'TD')
    if (cells.length !== 2 || row.querySelector('table')) continue
    const label = clean(cells[0]?.textContent)
    if (!label) continue
    if (out.has(label)) throw new FieldError('duplicate-label')
    out.set(label, clean(cells[1]?.textContent))
  }
  return out
}

/** Reads a single-column table where a label row is followed by its value row. */
export function alternatingRows(doc: Doc, tableSelector: string): Map<string, string> {
  const tables = doc.querySelectorAll(tableSelector)
  if (tables.length !== 1) throw new FieldError('layout')
  const texts = [...(tables[0]?.querySelectorAll('tr') ?? [])].map((row) => {
    const cells = [...row.children].filter((c) => c.tagName === 'TD')
    if (cells.length !== 1) throw new FieldError('layout')
    return clean(cells[0]?.textContent)
  })
  if (texts.length === 0 || texts.length % 2 !== 0) throw new FieldError('layout')
  const out = new Map<string, string>()
  for (let i = 0; i < texts.length; i += 2) {
    const label = texts[i] ?? ''
    if (!label || out.has(label)) throw new FieldError('duplicate-label')
    out.set(label, texts[i + 1] ?? '')
  }
  return out
}

/**
 * Takes the fields a template knows. Any label the template does not list means the bank
 * changed the mail, and the parse fails instead of silently ignoring new information.
 */
export function takeFields<K extends string>(
  rows: Map<string, string>,
  labels: Record<K, readonly string[]>,
  optional: readonly K[] = [],
): Record<K, string | undefined> {
  const known = new Set(Object.values<readonly string[]>(labels).flat())
  for (const label of rows.keys()) if (!known.has(label)) throw new FieldError('unknown-label')
  const out = {} as Record<K, string | undefined>
  for (const key of Object.keys(labels) as K[]) {
    const hit = labels[key].find((l) => rows.has(l))
    if (hit === undefined && !optional.includes(key)) throw new FieldError(key)
    out[key] = hit === undefined ? undefined : rows.get(hit)
  }
  return out
}
