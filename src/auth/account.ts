import type { Sql } from '../core/db'

/**
 * What the account page does with a person's data (docs/design.md, "Auth"): disconnect every agent, hand over everything as JSON,
 * delete it all. Each takes the account from the signed-in session, never from the request.
 */

/**
 * The account a user stands for, made if the user has none yet. Idempotent and safe to race: the user row is locked, so two callers
 * make one account. The user's create hook calls it, and so do the account page and the door, so a person whose hook failed once is
 * repaired on next use instead of locked out.
 */
export async function ensureAccount(sql: Sql, userId: string): Promise<number | null> {
  return sql.begin(async (tx) => {
    const [user] = await tx<{ account: number | null }[]>`
      SELECT warren_account_id AS account FROM auth_user WHERE id = ${userId}::uuid FOR UPDATE`
    if (!user) return null
    if (user.account !== null) return user.account
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
    const id = (row as { id: number }).id
    await tx`UPDATE auth_user SET warren_account_id = ${id} WHERE id = ${userId}::uuid`
    return id
  })
}

/** A delete needs a sign-in younger than this: the session proves the person is at the keyboard now. */
export const FRESH_SIGN_IN_MS = 5 * 60 * 1000

/** Whether a session was created recently enough to delete an account. */
export const isFreshSignIn = (createdAt: Date, now: Date = new Date()): boolean =>
  now.getTime() - createdAt.getTime() <= FRESH_SIGN_IN_MS

/**
 * "Disconnect all agents": the door refuses every access token issued at or before now, and in the same transaction the person's
 * refresh and access tokens are revoked and their consents deleted, so a refresh token cannot mint a newer one and every agent has
 * to ask (and be allowed) again.
 */
export async function disconnectAgents(sql: Sql, accountId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE account SET mcp_revoked_at = now() WHERE id = ${accountId}`
    const user = tx`(SELECT id FROM auth_user WHERE warren_account_id = ${accountId})`
    await tx`UPDATE auth_oauth_refresh_token SET revoked = now() WHERE "userId" = ${user} AND revoked IS NULL`
    await tx`UPDATE auth_oauth_access_token SET revoked = now() WHERE "userId" = ${user} AND revoked IS NULL`
    await tx`DELETE FROM auth_oauth_consent WHERE "userId" = ${user}`
  })
}

/** Everything Warren keeps for the account, every version of every row, as plain data. */
export async function exportAccount(sql: Sql, accountId: number) {
  // One snapshot, so the file is one moment of the ledger.
  return sql.begin('isolation level repeatable read read only', async (raw) => {
    const tx = raw as unknown as Sql
    const [account] = await tx`
      SELECT a.id::int AS id, a.created_at, u.email
      FROM account a LEFT JOIN auth_user u ON u.warren_account_id = a.id WHERE a.id = ${accountId}`
    const turns = await tx`
      SELECT id::int AS id, client, created_at, record, undoes::int AS undoes, calls
      FROM turn WHERE account_id = ${accountId} ORDER BY id`
    const movements = await tx`
      SELECT id::int AS version, entity_id::int AS id, made_in::int AS made_in, ended_in::int AS ended_in, ended_at,
        logged_at, direction, amount::text AS amount, currency, to_char(occurred_on, 'YYYY-MM-DD') AS date,
        description, category, payment, confidence
      FROM movement WHERE account_id = ${accountId} ORDER BY movement.id`
    const facts = await tx`
      SELECT id::int AS version, entity_id::int AS id, made_in::int AS made_in, ended_in::int AS ended_in, ended_at,
        logged_at, kind, key, value
      FROM fact WHERE account_id = ${accountId} ORDER BY fact.id`
    return { exported_at: new Date().toISOString(), account, turns, movements, facts }
  })
}

/**
 * Deletes the account and every row of it, in one transaction, through `erase_account`: the one database function the append-only
 * guard lets delete (`002_auth.sql`). Nothing else in Warren calls it (a test holds that). The caller has checked the sign-in is fresh.
 */
export async function eraseAccount(sql: Sql, accountId: number): Promise<void> {
  await sql.begin(async (tx) => {
    // The account lock first, like every write: no turn of this account is half-done while its rows go.
    await tx`SELECT 1 FROM account WHERE id = ${accountId} FOR NO KEY UPDATE`
    await tx`SELECT erase_account(${accountId})`
  })
}
