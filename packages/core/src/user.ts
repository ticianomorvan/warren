const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The one spelling of a user id: lower case, as Postgres prints a uuid. The id is also the
 * associated data of the wrapped key, the seed of the chain and part of every file path, so
 * every entry point (database, intake, erasure, the operator scripts, the environment) goes
 * through this, never a raw string.
 */
export function canonicalUserId(id: string): string {
  if (!UUID.test(id)) throw new Error('user id must be a uuid')
  return id.toLowerCase()
}

/** Thrown when work starts for a user who was erased. Never a new key, never a new row. */
export class UserErasedError extends Error {
  constructor() {
    super('user was erased')
    this.name = 'UserErasedError'
  }
}
