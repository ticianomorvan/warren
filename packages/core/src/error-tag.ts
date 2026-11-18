/**
 * What may be logged about an error: its class and, for a database error, the SQLSTATE code.
 * Never the message: a failed query's message carries its bound parameters (a To address, a
 * counterparty's name or CBU), and rule 3 keeps those out of logs.
 */
export function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const code = sqlState(error) ?? sqlState(error.cause)
  return code ? `${error.name} ${code}` : error.name
}

function sqlState(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('code' in value)) return undefined
  const code = (value as { code: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}
