import type { Sql } from './core/db'

/** Normalized WhatsApp ids that get a reply; `*` means everyone, empty answers nobody. The one list WhatsApp and the MCP door answer by. */
export const isAllowed = (allowed: string[], waId: string) =>
  allowed.includes('*') || allowed.includes(waId)

/**
 * The WhatsApp address of an account (its normalized wa_id), or null when it has none. Reminders are sent there, and `/mcp`'s door
 * admits only an account that has one; the transaction handle works as well as the pool.
 */
export async function whatsappAddress(sql: Sql, accountId: number): Promise<string | null> {
  const [row] = await sql<{ address: string }[]>`
    SELECT address FROM account_address WHERE account_id = ${accountId} AND channel = 'whatsapp'`
  return row?.address ?? null
}
