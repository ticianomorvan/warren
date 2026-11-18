import { formatMoney } from '@warren/core'
import type { MovementListItem } from '@warren/db'
import { t } from './strings'

/** What to call a movement: the merchant or the other party, else what kind it is. */
export function movementTitle(m: MovementListItem): string {
  if (m.type === 'own_transfer') return t.movements.ownTransfer
  return m.counterpartyName ?? kindLabel(m)
}

export function kindLabel(m: MovementListItem): string {
  if (m.type === 'card_purchase') return t.movements.purchase
  if (m.type === 'own_transfer') return t.movements.ownTransfer
  return m.direction === 'out' ? t.movements.transferOut : t.movements.transferIn
}

function route(m: MovementListItem): string | null {
  if (m.type !== 'own_transfer') return m.accountName
  const [from, to] =
    m.direction === 'out'
      ? [m.accountName, m.counterAccountName]
      : [m.counterAccountName, m.accountName]
  return from || to ? `${from ?? ''} → ${to ?? ''}`.trim() : null
}

/** The line under the title: the kind (when the title is a name), the route or account, the time. */
export function movementDetail(m: MovementListItem): string {
  const named = m.type !== 'own_transfer' && m.counterpartyName !== null
  return [named ? kindLabel(m) : null, route(m), m.time ? m.time.slice(0, 5) : null]
    .filter(Boolean)
    .join(' · ')
}

/** "−$ 1.500,00", "+$ 1.500,00", or "$ 1.500,00" between the person's own accounts. */
export function movementAmount(m: MovementListItem): string {
  const money = formatMoney(m.amount, m.currency)
  if (m.type === 'own_transfer') return money
  return `${m.direction === 'out' ? '−' : '+'}${money}`
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

/** "2026-11-14" becomes "14 de noviembre", with the year when it is not `thisYear`. */
export function dayHeading(date: string, thisYear: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const name = MONTHS[(month ?? 1) - 1] ?? ''
  return `${day} de ${name}${year === thisYear ? '' : ` de ${year}`}`
}
