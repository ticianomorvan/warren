import type { Changes, RecentMovement } from './agent'

export { canonicalAmount, normalizeText } from './core/values'

import { canonicalAmount } from './core/values'

/** The values a correction leaves unset keep the old row's. Blank values never get here: validate rejects them. */
export function applyChanges(old: RecentMovement, changes: Changes): RecentMovement {
  return {
    direction: changes.direction ?? old.direction,
    amount: changes.amount ?? old.amount,
    currency: changes.currency ?? old.currency,
    date: changes.date ?? old.date,
    description: changes.description?.trim() ?? old.description,
    category: changes.category ?? old.category,
    payment: changes.payment?.trim() ?? old.payment,
  }
}

export type ChangedField = 'money' | 'date' | 'description' | 'category' | 'payment'

/** Which fields a correction actually changes. Direction, currency and amount count as one: the money. */
export function changedFields(before: RecentMovement, after: RecentMovement): ChangedField[] {
  const changed: ChangedField[] = []
  if (
    before.direction !== after.direction ||
    before.currency !== after.currency ||
    canonicalAmount(before.amount) !== canonicalAmount(after.amount)
  ) {
    changed.push('money')
  }
  if (before.date !== after.date) changed.push('date')
  if (before.description.trim() !== after.description.trim()) changed.push('description')
  if (before.category !== after.category) changed.push('category')
  if ((before.payment?.trim() || null) !== (after.payment?.trim() || null)) changed.push('payment')
  return changed
}
