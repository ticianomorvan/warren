import { readdir, readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { log } from './log'

export type Sql = postgres.Sql

export function connect(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): Sql {
  return postgres(url, { onnotice: () => {}, ...options })
}

const dir = new URL('./migrations/', import.meta.url)

/** Applies each `NNN_name.sql` once, in order, under an advisory lock. Safe to run on every start. */
export async function migrate(sql: Sql): Promise<void> {
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
