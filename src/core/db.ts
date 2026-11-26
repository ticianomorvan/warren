import { readdir, readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { log } from '../log'

export type Sql = postgres.Sql

/**
 * Ids are `bigint` in the schema and plain numbers in code: the driver reads a bigint as a number, and refuses one that a number
 * cannot hold exactly. So no query casts an id down to `int`, which would fail at 2^31.
 */
const bigint: postgres.PostgresType<number> = {
  to: 20,
  from: [20],
  serialize: (n) => String(n),
  parse: (text) => {
    const n = Number(text)
    if (!Number.isSafeInteger(n)) throw new Error(`a bigint of ${text} does not fit a number`)
    return n
  },
}

export function connect(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): Sql {
  return postgres(url, { onnotice: () => {}, types: { bigint }, ...options })
}

/** The schema (`001_init.sql`, `002_auth.sql`). */
export const schemaDir = new URL('./schema/', import.meta.url)

/**
 * Applies each `NNN_name.sql` once, in order, under an advisory lock. Safe to run on every start.
 *
 * The one advisory lock in use is 7203001, the migrations. A person's data has no advisory lock: every write transaction takes the
 * account row's lock first.
 */
export async function migrate(sql: Sql, dir: URL = schemaDir): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7203001)`
    await tx`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    for (const name of files) {
      const [done] = await tx`SELECT 1 FROM schema_migration WHERE name = ${name}`
      if (done) continue
      await tx.unsafe(await readFile(new URL(name, dir), 'utf8'))
      await tx`INSERT INTO schema_migration (name) VALUES (${name})`
      log('migration_applied', { name })
    }
  })
}
