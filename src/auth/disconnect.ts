import type { Sql } from '../core/db'

/**
 * "desconectar" (docs/mcp-spec.md, Slice 3): cuts every connection of an agent to this account, inside the commit transaction
 * of the message that asked. Its refresh tokens are revoked, its consents, the browser sessions of its user and its pending authorization codes removed, and the
 * account is stamped `mcp_revoked_at`: the door of `/mcp` refuses every access token issued at or before it, so a token that is
 * still live stops working on its next call. A sign-in that was waiting is closed. Returns how many clients (Claude, Claude
 * Code...) were connected: 0 when there was nothing to cut. Reconnecting is a new sign-in, whose tokens are newer than the stamp.
 */
export async function disconnectAccount(tx: Sql, accountId: number): Promise<number> {
  await tx`UPDATE account SET mcp_revoked_at = now() WHERE id = ${accountId}`
  await tx`
    UPDATE link_request SET used_at = now()
    WHERE account_id = ${accountId} AND used_at IS NULL`
  const [user] = await tx<
    { id: string }[]
  >`SELECT id FROM auth_user WHERE warren_account_id = ${accountId}`
  if (!user) return 0
  const consents = await tx<{ clientId: string }[]>`
    DELETE FROM auth_oauth_consent WHERE "userId" = ${user.id}::uuid RETURNING "clientId"`
  const refresh = await tx<{ clientId: string }[]>`
    UPDATE auth_oauth_refresh_token SET revoked = now()
    WHERE "userId" = ${user.id}::uuid AND revoked IS NULL RETURNING "clientId"`
  await tx`
    UPDATE auth_oauth_access_token SET revoked = now()
    WHERE "userId" = ${user.id}::uuid AND revoked IS NULL`
  await tx`DELETE FROM auth_session WHERE "userId" = ${user.id}::uuid`
  // An authorization code issued just before the cut (consent given, not yet exchanged) is a pending verification: it must
  // not turn into tokens after it. better-auth stores them with the user's id in their JSON value.
  await tx`DELETE FROM auth_verification WHERE value LIKE ${`%"userId":"${user.id}"%`}`
  return new Set([...consents, ...refresh].map((r) => r.clientId)).size
}
