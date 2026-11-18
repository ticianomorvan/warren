import { attachDatabasePool } from '@vercel/functions'
import { signupPolicy } from '@warren/core'
import { createAuthDatabase, createPool, provisionUser } from '@warren/db'
import { type Auth, createAuth } from './auth-config'
import { database } from './db'
import { env } from './env'

let cached: Auth | undefined

/** Built on first use, so a build without secrets still succeeds. */
export function auth(): Auth {
  if (cached) return cached
  const pool = createPool(env.databaseUrlAuth())
  attachDatabasePool(pool)
  cached = createAuth({
    db: createAuthDatabase(pool),
    secret: env.authSecret(),
    baseURL: env.authUrl(),
    signup: signupPolicy(env.signupEmails()),
    onUserCreated: (userId) => provisionUser(database(), userId),
  })
  return cached
}
