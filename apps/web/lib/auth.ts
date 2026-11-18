import { attachDatabasePool } from '@vercel/functions'
import { signupPolicy } from '@warren/core'
import {
  createAuthDatabase,
  createKeylessDatabase,
  createPool,
  type Database,
  provisionUser,
} from '@warren/db'
import { type Auth, createAuth } from './auth-config'
import { database } from './db'
import { env } from './env'

let cached: Auth | undefined
let pool: ReturnType<typeof createPool> | undefined

/** One pool per instance for everything that connects as warren_auth. */
function authPool() {
  if (pool) return pool
  pool = createPool(env.databaseUrlAuth())
  attachDatabasePool(pool)
  return pool
}

/**
 * The same login as a `Database`, for the few things outside Better Auth that live in its
 * tables (a rate limit). It holds no master key: nothing sealed passes through it.
 */
export function authDatabase(): Database {
  return createKeylessDatabase(authPool())
}

/** Built on first use, so a build without secrets still succeeds. */
export function auth(): Auth {
  if (cached) return cached
  cached = createAuth({
    db: createAuthDatabase(authPool()),
    secret: env.authSecret(),
    ...env.authOrigins(),
    signup: signupPolicy(env.signupEmails()),
    onUserCreated: (userId) => provisionUser(database(), userId),
  })
  return cached
}
