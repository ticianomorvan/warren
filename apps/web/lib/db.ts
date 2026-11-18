import { attachDatabasePool } from '@vercel/functions'
import { createDatabase, createPool, type Database } from '@warren/db'
import { env } from './env'

let cached: Database | undefined

/**
 * One pool per function instance, released by Vercel before the instance is suspended. The
 * handle has no way to run a query: reach a user's data through `asUser`.
 */
export function database(): Database {
  if (cached) return cached
  const pool = createPool(env.databaseUrl())
  attachDatabasePool(pool)
  cached = createDatabase(pool, env.masterKeys())
  return cached
}
