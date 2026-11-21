export type Fields = Record<string, unknown>

/** One JSON object per line on stdout. Callers never pass secrets. */
export function log(event: string, fields: Fields = {}): void {
  if (process.env.VITEST) return
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))
}
