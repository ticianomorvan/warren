import type { Sql } from '../core/db'

/** How long a self-registered client may wait for a first consent before it is forgotten. */
export const UNCONSENTED_CLIENT_HOURS = 24

/**
 * Deletes the clients that registered themselves (DCR: their id is not a document URL) and never got a person's consent within a day,
 * with what hangs from them by cascade. Open registration would otherwise fill the table with clients nobody ever used. Not
 * append-only data: a client is not a person's. Runs at start and every hour.
 */
export async function expireUnconsentedClients(sql: Sql): Promise<number> {
  const gone = await sql`
    DELETE FROM auth_oauth_client c
    WHERE c."clientId" NOT LIKE 'https://%'
      AND c."createdAt" < now() - make_interval(hours => ${UNCONSENTED_CLIENT_HOURS})
      AND NOT EXISTS (SELECT 1 FROM auth_oauth_consent k WHERE k."clientId" = c."clientId")
      AND NOT EXISTS (SELECT 1 FROM auth_oauth_refresh_token t WHERE t."clientId" = c."clientId")
    RETURNING c.id`
  return gone.length
}
