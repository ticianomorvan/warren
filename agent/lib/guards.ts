import { shown } from './state'

/** The message a refused id gets: the same reason the loop gives (src/agent/calls.ts). */
export const notShown = (ids: number[]) =>
  `id ${ids.join(', ')} was not shown to you. Use only ids from the "Últimos movimientos" list, a find_movements result or a log_movements result; call find_movements to look for an older movement.`

/** The ids among `ids` that this session never showed the model. Needs an eve context. */
export function unseen(ids: number[]): number[] {
  const seen = new Set(shown.get().ids)
  return ids.filter((id) => !Number.isSafeInteger(id) || id < 1 || !seen.has(id))
}
