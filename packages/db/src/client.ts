import { drizzle } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import * as schema from './schema'

/** Driver-independent handle: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export function createPool(connectionString: string): Pool {
  // Short idle timeout: serverless instances are suspended between requests.
  return new Pool({ connectionString, max: 5, idleTimeoutMillis: 5000 })
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema })
}
