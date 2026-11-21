export type Fields = Record<string, unknown>

/** One JSON object per line on stdout; `level` is what Railway reads. Callers never pass secrets. */
export function log(event: string, fields: Fields = {}, level: 'info' | 'error' = 'info'): void {
  if (process.env.VITEST) return
  console.log(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }))
}
