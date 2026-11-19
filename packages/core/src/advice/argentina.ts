const TIME_ZONE = 'America/Argentina/Buenos_Aires'

const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

// Sweden's locale writes "2026-11-19 12:30", which is the shape the ledger tools use.
const minute = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** The ledger's days are Argentine days: "2026-11-19" for the instant, by the date there, not in UTC. */
export const argentinaDay = (at: Date): string => day.format(at)

/** "2026-11-19 12:30": the instant as an Argentine wall clock, for a person or an agent to read. */
export const argentinaMinute = (at: Date): string => minute.format(at)
