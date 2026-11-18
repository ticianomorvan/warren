/** Shared by the operator scripts: arguments, and connections that go through `asUser`. */
import { masterKeysFromEnv } from '@warren/core'
import {
  canonicalUserId,
  createDatabase,
  createKeylessDatabase,
  createPool,
  type Database,
} from '@warren/db'

const args = process.argv.slice(2)

export function die(message: string): never {
  console.error(message)
  process.exit(2)
}

/** Value after `--name`, or undefined. */
export function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

export const has = (name: string) => args.includes(`--${name}`)

/** Arguments that are neither a flag nor a flag's value. */
export function positionals(valueFlags: readonly string[] = []): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a.startsWith('--')) {
      if (valueFlags.includes(a.slice(2))) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** The user a command acts for: `--user <uuid>`, in its canonical (lower-case) spelling. */
export function userArg(): string {
  const id = flag('user')
  if (!id) die('Pass --user <user id> (a uuid).')
  try {
    return canonicalUserId(id)
  } catch {
    return die('Pass --user <user id> (a uuid).')
  }
}

/** A connection from an environment variable, or an error that names it. */
function poolFrom(variable: string) {
  const url = process.env[variable]
  if (!url) die(`Set ${variable} (apps/web/.env.local is read automatically)`)
  return createPool(url)
}

/**
 * A connection for a command that never seals or opens anything (setting a password, erasing a
 * user): it needs no `WARREN_MASTER_KEY`.
 */
export function connectKeyless(variable: string): {
  pool: ReturnType<typeof createPool>
  database: Database
} {
  const pool = poolFrom(variable)
  return { pool, database: createKeylessDatabase(pool) }
}

/** A database connection from an environment variable, with the master key for sealing. */
export function connect(variable: string): {
  pool: ReturnType<typeof createPool>
  database: Database
} {
  const pool = poolFrom(variable)
  return { pool, database: createDatabase(pool, masterKeysFromEnv(process.env)) }
}
