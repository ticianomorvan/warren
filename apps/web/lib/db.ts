import { attachDatabasePool } from '@vercel/functions'
import { createDb, createPool, type Db } from '@warren/db'
import { env } from './env'

let cached: Db | undefined

/** One pool per function instance, released by Vercel before the instance is suspended. */
export function db(): Db {
  if (cached) return cached
  const pool = createPool(env.databaseUrl())
  attachDatabasePool(pool)
  cached = createDb(pool)
  return cached
}
