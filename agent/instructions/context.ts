import { defineDynamic, defineInstructions } from 'eve/instructions'
import { movementLine } from '../../src/agent/prompt'
import { recentMovements } from '../../src/ledger'
import { addDays, weekdayName } from '../../src/time'
import { accountOf, ledger, nowOf } from '../lib/core'
import { markShown, turnClock, turnFacts } from '../lib/state'

/** Minutes since the epoch of an Argentine `yyyy-mm-ddTHH:MM` (UTC-3, no daylight saving). */
const minutesOf = (iso: string) => Date.parse(`${iso}:00-03:00`) / 60_000

/**
 * The per-turn context: today's Argentine date and time, a 14-day calendar and the 10 newest live
 * movements with their ids. A user-role dynamic instruction: eve runs it before every model call, so the
 * database read sits in a memo keyed on the turn, and the text joins the history only when it changes
 * (the time changes every minute, so in practice once per turn).
 */
export default defineDynamic(async (ctx) => {
  const waId = ctx.session.auth.current?.principalId
  if (!waId) return null
  const turnId = ctx.turn?.id ?? null
  const clock = turnClock.get()
  const previousNow = clock.turnId === String(turnId) ? clock.prev : clock.now
  const rendered = await ctx.memo(['context', turnId], async () => {
    const sql = ledger()
    const { today, time } = await nowOf(sql, waId)
    const nowIso = `${today}T${time}`
    const minutes = previousNow ? Math.max(0, minutesOf(nowIso) - minutesOf(previousNow)) : null
    const accountId = await accountOf(sql, waId)
    const movements = await recentMovements(sql, accountId)
    const calendar = Array.from({ length: 14 }, (_, k) => {
      const day = addDays(today, -k)
      const label = k === 0 ? 'hoy' : k === 1 ? 'ayer' : `hace ${k} días`
      return `${weekdayName(day)} ${day} (${label})`
    })
    const list =
      movements.length === 0
        ? '(ninguno)'
        : movements.map((m, k) => `${k + 1}. ${movementLine(m)}`).join('\n')
    const text = [
      `Hoy es ${weekdayName(today)} ${today}, ${time} (America/Argentina/Buenos_Aires).`,
      minutes === null
        ? 'Es el primer mensaje de la conversación.'
        : `Hace ${minutes} min que la persona escribió su mensaje anterior.`,
      `Calendario, del más reciente al más antiguo:\n${calendar.join('\n')}`,
      `Últimos movimientos de la persona, el más reciente primero:\n${list}`,
    ].join('\n\n')
    return { text, ids: movements.map((m) => m.id), nowIso }
  })
  if (clock.turnId !== String(turnId)) {
    turnClock.update(() => ({ turnId: String(turnId), now: rendered.nowIso, prev: clock.now }))
  }
  markShown(rendered.ids)
  turnFacts.update(() => ({ turnId: String(turnId), text: rendered.text }))
  return defineInstructions({ content: rendered.text, role: 'user' })
})
