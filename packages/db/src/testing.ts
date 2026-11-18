import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { masterKeysFromEnv } from '@warren/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { type Database, type Db, openDatabase } from './client'
import * as schema from './schema'
import { createTestUser } from './tenancy-check'

export const MASTER = Buffer.alloc(32, 42).toString('base64')
export const masters = masterKeysFromEnv({ WARREN_MASTER_KEY: MASTER })

/**
 * A fresh in-process Postgres with the real migrations. PGlite connects as a superuser, who
 * ignores row-level security, so `app`, `auth` and `eraser` run every transaction as that role.
 */
export async function testDatabase() {
  const pg = new PGlite()
  await migrate(drizzle(pg), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  })
  const db = drizzle(pg, { schema }) as unknown as Db
  const as = (role?: string) => openDatabase(db, masters, role ? { role } : {})
  const owner: Database = as()
  return {
    pg,
    owner,
    app: as('warren_app'),
    auth: as('warren_auth'),
    eraser: as('warren_eraser'),
    newUser: (label: string) => createTestUser(owner, label),
  }
}

export const sha = (c: string) => c.repeat(64)
