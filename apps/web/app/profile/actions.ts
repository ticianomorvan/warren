'use server'

import { errorTag, type ProfileIssue, parseProfile } from '@warren/core'
import { appendProfile, asUser } from '@warren/db'
import { database } from '@/lib/db'
import { getSession } from '@/lib/session'

/*
 * Saves the signed-in person's profile as a new version. A Server Action: Next checks the
 * request's Origin. It acts only for the session's user, through `asUser`, and validates with
 * the same `parseProfile` the agent's tool relies on. Nothing here logs the profile.
 */

export type SaveProfileResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'signed-out' | 'failed' }
  | { ok: false; reason: 'invalid'; issues: ProfileIssue[] }

export async function saveProfile(input: unknown): Promise<SaveProfileResult> {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'signed-out' }
  const parsed = parseProfile(input)
  if (!parsed.ok) return { ok: false, reason: 'invalid', issues: parsed.issues }
  try {
    const version = await asUser(database(), session.user.id, (scope) =>
      appendProfile(scope, parsed.profile),
    )
    return { ok: true, version }
  } catch (error) {
    console.error('save profile failed:', errorTag(error))
    return { ok: false, reason: 'failed' }
  }
}
