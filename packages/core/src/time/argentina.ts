const TIME_ZONE = 'America/Argentina/Buenos_Aires'

// Parts, not a locale's own layout, so the output does not depend on the ICU data.
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const wall = (at: Date) => {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

/** The ledger's days are Argentine days: "2026-11-19" for the instant, by the date there, not in UTC. */
export const argentinaDay = (at: Date): string => wall(at).date

/** "2026-11-19 12:30": the instant as an Argentine wall clock, for a person or an agent to read. */
export const argentinaMinute = (at: Date): string => {
  const w = wall(at)
  return `${w.date} ${w.time}`
}
