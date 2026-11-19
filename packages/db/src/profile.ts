import { type Profile, parseProfile } from '@warren/core'
import { desc, sql } from 'drizzle-orm'
import { lockUserExclusive, type Scope } from './client'
import { profile } from './schema'

// Sealed: the whole profile. The scope adds the user; this names the table, the version and the column.
const aad = (version: number) => `profile:${version}:data`

/** The advisory-lock purpose that puts one user's profile saves in a line (4200 is erasure, 4202 the ledger). */
const PROFILE_LOCK = 4203

export type StoredProfile = { version: number; created_at: string; profile: Profile }

/**
 * Saves a new version of the user's profile and returns its number. The next version is
 * `max + 1`, read after taking a per-user lock held to the end of the transaction, so two saves at
 * the same moment take turns and get consecutive versions. The primary key (`user_id, version`)
 * is the backstop: a version can never be reused or overwritten. The caller has already validated `data` with `parseProfile`.
 */
export async function appendProfile(scope: Scope, data: Profile): Promise<number> {
  await lockUserExclusive(scope.tx, scope.userId, PROFILE_LOCK)
  const rows = await scope.tx
    .select({ latest: sql<number>`coalesce(max(${profile.version}), 0)::int` })
    .from(profile)
  const version = (rows[0]?.latest ?? 0) + 1
  await scope.tx.insert(profile).values({ version, data: scope.json.seal(data, aad(version)) })
  return version
}

/** The user's latest profile, or null when they have never saved one. */
export async function latestProfile(scope: Scope): Promise<StoredProfile | null> {
  const row = (await scope.tx.select().from(profile).orderBy(desc(profile.version)).limit(1))[0]
  if (!row) return null
  const stored = scope.json.open<unknown>(row.data, aad(row.version))
  // Re-validated on the way out, so a row written by an older shape can never reach a person or an agent unchecked.
  const parsed = parseProfile(stored)
  if (!parsed.ok) throw new Error(`profile version ${row.version} is not a valid profile`)
  return { version: row.version, created_at: row.createdAt.toISOString(), profile: parsed.profile }
}
