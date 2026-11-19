import { FieldError, parseDate, parseMoney, parseText } from '../fields'
import type { Doc } from '../html'
import type { Template } from '../types'

type El = ReturnType<Doc['querySelector']> & object

const text = (el: { textContent: string | null } | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

const HEADING = 'Pagaste con tu tarjeta de crédito'

const cellsOf = (row: El): El[] => [...row.children].filter((c) => c.tagName === 'TD')

/** A value row: an icon cell, an empty cell, and a cell with one paragraph. Returns its text. */
function valueRow(row: El): string | null {
  const cells = cellsOf(row)
  if (cells.length !== 3 || row.children.length !== 3) return null
  const [icon, gap, value] = cells as [El, El, El]
  const paragraphs = value.querySelectorAll('p')
  if (!icon.querySelector('img') || text(icon) !== '') return null
  if (gap.querySelector('img') || text(gap) !== '') return null
  if (paragraphs.length !== 1) return null
  return text(paragraphs[0])
}

/** A spacer row: every cell empty and without an image. */
const isSpacer = (row: El) =>
  row.children.length > 0 && cellsOf(row).every((c) => text(c) === '' && !c.querySelector('img'))

/**
 * The three values, in order, of the one table whose rows are value rows (and spacers). The
 * mail labels none of them, so the position is the only label: date, merchant, amount.
 */
function valueRows(doc: Doc): string[] {
  const found: string[][] = []
  for (const table of doc.querySelectorAll('table')) {
    if (table.querySelector('table')) continue
    const values: string[] = []
    let shaped = true
    for (const row of table.querySelectorAll('tr')) {
      const v = valueRow(row)
      if (v !== null) values.push(v)
      else if (!isSpacer(row)) shaped = false
    }
    if (shaped && values.length > 0) found.push(values)
  }
  const three = found.filter((v) => v.length === 3)
  if (three.length > 1) throw new FieldError('layout')
  if (three[0]) return three[0]
  const short = found.find((v) => v.length < 3)
  if (short) throw new FieldError(['date', 'merchant', 'amount'][short.length] ?? 'layout')
  throw new FieldError(found.length > 0 ? 'layout' : 'date')
}

/**
 * The card's last four, from the paragraph after the heading: it must hold exactly one standalone
 * 4-digit run, right after "terminada en" (the wording of all 25 stored mails, 2026-11-18), so a
 * year or an amount is never taken for a card.
 */
function cardLastFour(doc: Doc): string {
  const paragraphs = [...doc.querySelectorAll('p')]
  const at = paragraphs.findIndex((p) => text(p) === HEADING)
  if (at < 0) throw new FieldError('heading')
  const intro = paragraphs.slice(at + 1).find((p) => text(p) !== '')
  const runs = text(intro).match(/\b\d{4}\b/g) ?? []
  const card = text(intro).match(/\bterminada en (\d{4})\b/i)?.[1]
  if (runs.length !== 1 || !card) throw new FieldError('card')
  return card
}

/**
 * "Compra aprobada": a purchase approved on a credit card. The heading must name a credit card,
 * so a debit or other variant fails closed instead of being read by guesswork.
 */
export const bbvaCardPurchase: Template = {
  id: 'bbva.card-purchase',
  kind: 'card',
  version: 1,
  senderId: 'bbva-cards',
  subject: /^Compra aprobada$/,
  parse(doc) {
    const last = cardLastFour(doc)
    const [date, merchant, amount] = valueRows(doc)
    return {
      kind: 'card_purchase',
      cardLastFour: last,
      merchant: parseText(merchant ?? '', 'merchant'),
      ...parseMoney(amount ?? ''),
      date: parseDate(date ?? ''),
      cardType: 'credit',
    }
  },
}
