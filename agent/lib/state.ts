import { defineState } from 'eve/context'

/**
 * Ids the model has been shown in this session: the context list of a turn and every `find_movements`
 * or `log_movements` result. A correction or delete may only name one of them (guard 2).
 */
export const shown = defineState('warren.shown', () => ({ ids: [] as number[] }))

export const markShown = (ids: number[]) =>
  shown.update((s) => ({ ids: [...new Set([...s.ids, ...ids])].slice(-500) }))

/** What the model was given as facts this turn (the context text), for the numbers check (guard 4). */
export const turnFacts = defineState('warren.turn-facts', () => ({ turnId: '', text: '' }))

/** The Argentine "now" of the turn that last built the context and of the one before it, to tell how long ago the person last wrote. */
export const turnClock = defineState('warren.turn-clock', () => ({
  turnId: '',
  now: '',
  prev: '' as string,
}))
