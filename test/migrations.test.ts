import { readdir } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth/config'
import { migrate, type Sql, schemaDir } from '../src/core/db'
import { createTestDatabase, realPostgres, type TestDatabase } from './db'

/** The new schema (`src/core/schema/`), applied to an empty database: PGlite, or a schema of its own on PG_TEST_URL. */
let db: TestDatabase
let sql: Sql

beforeAll(async () => {
  db = await createTestDatabase({ max: 3, migrations: schemaDir })
  sql = db.sql
})
afterAll(async () => {
  await db.close()
})

/** The name of the constraint, trigger message or index a statement broke: what the error says, not just that it failed. */
async function broke(run: PromiseLike<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    const e = error as { constraint_name?: string; message: string }
    return e.constraint_name ?? e.message
  }
  throw new Error('the statement was accepted')
}

let _n = 0
/** A person and the turn a version is made in. */
async function seed() {
  _n += 1
  const [account] = await sql<
    { id: number }[]
  >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
  const accountId = account?.id ?? 0
  return { accountId, turn: () => newTurn(accountId) }
}
async function newTurn(accountId: number): Promise<number> {
  const [t] = await sql<{ id: number }[]>`
    INSERT INTO turn (account_id, client) VALUES (${accountId}, 'test') RETURNING id::int AS id`
  return t?.id ?? 0
}
async function newMovement(
  accountId: number,
  madeIn: number,
  amount: string | number = 3500,
  description = 'café',
) {
  const [m] = await sql<{ id: number; entity_id: number }[]>`
    INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
    VALUES (${accountId}, ${madeIn}, 'out', ${amount}, 'ARS', '2026-11-20', ${description}, 'restaurantes', 'high')
    RETURNING id::int AS id, entity_id::int AS entity_id`
  return { id: m?.id ?? 0, entityId: m?.entity_id ?? 0 }
}
describe('applying', () => {
  it('records every file once, and applying again changes nothing', async () => {
    const files = (await readdir(schemaDir)).filter((f) => f.endsWith('.sql')).sort()
    expect(files).toEqual(['001_init.sql', '002_auth.sql'])
    const first = await sql`SELECT name, applied_at FROM schema_migration ORDER BY name`
    expect(first.map((r) => r.name)).toEqual(files)
    await migrate(sql, schemaDir)
    const second = await sql`SELECT name, applied_at FROM schema_migration ORDER BY name`
    expect(second).toEqual(first)
  })

  it('creates the tables, each with a comment saying what a row is', async () => {
    const tables = await sql<{ name: string; comment: string | null }[]>`
      SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname <> 'schema_migration'
      ORDER BY c.relname`
    expect(tables.map((t) => t.name)).toEqual(
      [
        'account',
        'auth_account',
        'auth_jwks',
        'auth_oauth_access_token',
        'auth_oauth_client',
        'auth_oauth_client_assertion',
        'auth_oauth_client_resource',
        'auth_oauth_consent',
        'auth_oauth_refresh_token',
        'auth_oauth_resource',
        'auth_session',
        'auth_user',
        'auth_verification',
        'fact',
        'mcp_request',
        'movement',
        'turn',
      ].sort(),
    )
    expect(tables.filter((t) => !t.comment).map((t) => t.name)).toEqual([])
  })

  it('has everything better-auth 1.7.26 and its plugins want: no table or column is missing', async () => {
    const auth = createAuth({
      sql,
      publicUrl: 'https://example.test',
      secret: 'x'.repeat(40),
      google: { clientId: 'x', clientSecret: 'x' },
    })
    const plan = await getMigrations(auth.options)
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([])
    expect(plan.toBeAdded.map((t) => t.table)).toEqual([])
    expect(plan.schemaProblems).toEqual([])
  })
})

describe('turn', () => {
  it('refuses a turn that undoes itself', async () => {
    const { accountId } = await seed()
    expect(
      await broke(
        sql`INSERT INTO turn (id, account_id, client, undoes) VALUES (987654, ${accountId}, 'cli', 987654)`,
      ),
    ).toBe('turn_undoes_earlier')
  })

  it('refuses an undo of another account’s turn, and an undo of a later turn', async () => {
    const mine = await seed()
    const theirs = await seed()
    const theirTurn = await theirs.turn()
    expect(
      await broke(
        sql`INSERT INTO turn (account_id, client, undoes) VALUES (${mine.accountId}, 'cli', ${theirTurn})`,
      ),
    ).toBe('turn_undoes_same_account')
    const first = await mine.turn()
    expect(
      await broke(
        sql`INSERT INTO turn (id, account_id, client, undoes) VALUES (${first - 1}, ${mine.accountId}, 'cli', ${first})`,
      ),
    ).toBe('turn_undoes_earlier')
  })

  it('refuses a version made or ended in another account’s turn', async () => {
    const mine = await seed()
    const theirs = await seed()
    const theirTurn = await theirs.turn()
    expect(
      await broke(
        sql`INSERT INTO movement (account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
          VALUES (${mine.accountId}, ${theirTurn}, 'out', 1, 'ARS', '2026-11-20', 'x', 'otros', 'high')`,
      ),
    ).toBe('movement_made_in_turn')
    const own = await newMovement(mine.accountId, await mine.turn())
    expect(
      await broke(
        sql`UPDATE movement SET ended_in = ${theirTurn}, ended_at = now() WHERE id = ${own.id}`,
      ),
    ).toBe('movement_ended_in_turn')
  })

  it('refuses a second undo of the same turn', async () => {
    const s = await seed()
    const target = await s.turn()
    await sql`INSERT INTO turn (account_id, client, undoes) VALUES (${s.accountId}, 'cli', ${target})`
    expect(
      await broke(
        sql`INSERT INTO turn (account_id, client, undoes) VALUES (${s.accountId}, 'https://claude.ai/c.json', ${target})`,
      ),
    ).toBe('turn_undoes_once')
  })

  it('refuses a turn with no client', async () => {
    const { accountId } = await seed()
    expect(await broke(sql`INSERT INTO turn (account_id, client) VALUES (${accountId}, '')`)).toBe(
      'turn_client_not_empty',
    )
  })

  it('holds one answer per request id', async () => {
    const s = await seed()
    const t = await s.turn()
    await sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r1', 'h', ${t}, '{}')`
    expect(
      await broke(
        sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r1', 'h', ${t}, '{}')`,
      ),
    ).toBe('mcp_request_pkey')
  })
})

describe('versions', () => {
  it('refuses two live versions of one entity, and allows the next once the first ended', async () => {
    const s = await seed()
    const t1 = await s.turn()
    const t2 = await s.turn()
    const first = await newMovement(s.accountId, t1)
    const insertVersion = () => sql`
      INSERT INTO movement (entity_id, account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${first.entityId}, ${s.accountId}, ${t2}, 'out', 3800, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high')`
    expect(await broke(insertVersion())).toBe('movement_one_live_version')
    await sql`UPDATE movement SET ended_in = ${t2}, ended_at = now() WHERE id = ${first.id}`
    await insertVersion()
    const live =
      await sql`SELECT id FROM movement WHERE entity_id = ${first.entityId} AND ended_at IS NULL`
    expect(live).toHaveLength(1)
  })

  it('refuses ended_at without ended_in, and ended_in without ended_at', async () => {
    const s = await seed()
    const t = await s.turn()
    const a = await newMovement(s.accountId, t)
    expect(await broke(sql`UPDATE movement SET ended_at = now() WHERE id = ${a.id}`)).toBe(
      'movement_ended_pair',
    )
    expect(await broke(sql`UPDATE movement SET ended_in = ${t} WHERE id = ${a.id}`)).toBe(
      'movement_ended_pair',
    )
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t}, 'alias', 'visa', 'la del Galicia') RETURNING id::int AS id`
    expect(await broke(sql`UPDATE fact SET ended_at = now() WHERE id = ${f?.id ?? 0}`)).toBe(
      'fact_ended_pair',
    )
  })

  it('refuses a 3-decimal amount, zero and a negative one, and keeps 2 decimals', async () => {
    const s = await seed()
    const t = await s.turn()
    expect(await broke(newMovement(s.accountId, t, '10.001'))).toBe('movement_amount_cents')
    expect(await broke(newMovement(s.accountId, t, '0'))).toBe('movement_amount_positive')
    expect(await broke(newMovement(s.accountId, t, '-5'))).toBe('movement_amount_positive')
    const ok = await newMovement(s.accountId, t, '1500000.50')
    const [row] = await sql<
      { amount: string }[]
    >`SELECT amount::text FROM movement WHERE id = ${ok.id}`
    expect(row?.amount).toBe('1500000.50')
  })

  it('refuses a second live fact with the same account, kind and key', async () => {
    const s = await seed()
    const t = await s.turn()
    const insert = (value: string) =>
      sql`INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t}, 'alias', 'visa', ${value})`
    await insert('la del Galicia')
    expect(await broke(insert('la del Santander'))).toBe('fact_one_live_key')
  })

  it('folds accents and case into `search`, as v1 does', async () => {
    const s = await seed()
    const t = await s.turn()
    const m = await newMovement(s.accountId, t, 100, 'Café con ÑOQUIS y pingüino')
    const [row] = await sql<{ search: string }[]>`SELECT search FROM movement WHERE id = ${m.id}`
    expect(row?.search).toBe('cafe con noquis y pinguino restaurantes')
    const found =
      await sql`SELECT id FROM movement WHERE account_id = ${s.accountId} AND search LIKE ALL (${['%cafe%', '%noquis%']}::text[])`
    expect(found).toHaveLength(1)
  })
})

describe('the append-only guard', () => {
  it('runs here: the trigger exists and plpgsql is available', async () => {
    const [row] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname LIKE '%append_only' AND NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace`
    expect(row?.n).toBe(4)
  })

  it('rejects an UPDATE of a value column', async () => {
    const s = await seed()
    const t = await s.turn()
    const m = await newMovement(s.accountId, t)
    expect(await broke(sql`UPDATE movement SET amount = 1 WHERE id = ${m.id}`)).toMatch(
      /append-only/,
    )
    expect(await broke(sql`UPDATE movement SET description = 'otro' WHERE id = ${m.id}`)).toMatch(
      /append-only/,
    )
    expect(
      await broke(sql`UPDATE movement SET occurred_on = '2026-01-01' WHERE id = ${m.id}`),
    ).toMatch(/append-only/)
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t}, 'note', 'cobro', 'el 5') RETURNING id::int AS id`
    expect(await broke(sql`UPDATE fact SET value = 'el 6' WHERE id = ${f?.id ?? 0}`)).toMatch(
      /append-only/,
    )
    expect(await broke(sql`UPDATE turn SET record = 'x' WHERE id = ${t}`)).toMatch(/append-only/)
    await sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r-guard', 'h', ${t}, '{}')`
    expect(
      await broke(sql`UPDATE mcp_request SET result = '{"a":1}' WHERE request_id = 'r-guard'`),
    ).toMatch(/append-only/)
  })

  it('rejects a DELETE, from any statement', async () => {
    const s = await seed()
    const t = await s.turn()
    const m = await newMovement(s.accountId, t)
    expect(await broke(sql`DELETE FROM movement WHERE id = ${m.id}`)).toMatch(/never deleted/)
    expect(await broke(sql`DELETE FROM turn WHERE id = ${await s.turn()}`)).toMatch(/never deleted/)
  })

  it('allows the ended pair, once', async () => {
    const s = await seed()
    const t1 = await s.turn()
    const t2 = await s.turn()
    const m = await newMovement(s.accountId, t1)
    await sql`UPDATE movement SET ended_in = ${t2}, ended_at = now() WHERE id = ${m.id}`
    // Once: an ended version keeps its ending, and cannot be revived.
    expect(await broke(sql`UPDATE movement SET ended_in = ${t1} WHERE id = ${m.id}`)).toMatch(
      /does not change its ending/,
    )
    expect(
      await broke(sql`UPDATE movement SET ended_in = NULL, ended_at = NULL WHERE id = ${m.id}`),
    ).toMatch(/does not change its ending/)

    const [f] = await sql<{ id: number }[]>`
      INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t1}, 'note', 'cobro2', 'el 5') RETURNING id::int AS id`
    await sql`UPDATE fact SET ended_in = ${t2}, ended_at = now() WHERE id = ${f?.id ?? 0}`
  })
})

describe('erase_account: the one way out', () => {
  async function filled(s: Awaited<ReturnType<typeof seed>>) {
    const t = await s.turn()
    const m = await newMovement(s.accountId, t)
    await sql`INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t}, 'note', 'cobro', 'el 5')`
    await sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r1', 'h', ${t}, '{}')`
    // A correction, so the account holds versions and an ended pair too.
    const t2 = await s.turn()
    await sql`UPDATE movement SET ended_in = ${t2}, ended_at = now() WHERE id = ${m.id}`
    await sql`INSERT INTO movement (entity_id, account_id, made_in, direction, amount, currency, occurred_on, description, category, confidence)
      VALUES (${m.entityId}, ${s.accountId}, ${t2}, 'out', 3800, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high')`
    await sql`INSERT INTO auth_user (name, email, "emailVerified", warren_account_id) VALUES ('x', ${`u${s.accountId}@example.test`}, true, ${s.accountId})`
  }
  const rows = (accountId: number) =>
    sql<{ t: string; n: number }[]>`
      SELECT 'account' AS t, count(*)::int AS n FROM account WHERE id = ${accountId}
      UNION ALL SELECT 'turn', count(*)::int FROM turn WHERE account_id = ${accountId}
      UNION ALL SELECT 'movement', count(*)::int FROM movement WHERE account_id = ${accountId}
      UNION ALL SELECT 'fact', count(*)::int FROM fact WHERE account_id = ${accountId}
      UNION ALL SELECT 'mcp_request', count(*)::int FROM mcp_request WHERE account_id = ${accountId}
      UNION ALL SELECT 'auth_user', count(*)::int FROM auth_user WHERE warren_account_id = ${accountId}`

  it('removes every row of that account, in one call, and not one of another', async () => {
    const gone = await seed()
    const kept = await seed()
    await filled(gone)
    await filled(kept)
    await sql`SELECT erase_account(${gone.accountId})`
    expect((await rows(gone.accountId)).map((r) => r.n)).toEqual([0, 0, 0, 0, 0, 0])
    expect((await rows(kept.accountId)).map((r) => [r.t, r.n])).toEqual([
      ['account', 1],
      ['turn', 2],
      ['movement', 2],
      ['fact', 1],
      ['mcp_request', 1],
      ['auth_user', 1],
    ])
  })

  it('leaves the guard shut afterwards: the same statements still fail outside it', async () => {
    const s = await seed()
    await filled(s)
    await sql`SELECT erase_account(${s.accountId})`
    const other = await seed()
    await filled(other)
    expect(await broke(sql`DELETE FROM movement WHERE account_id = ${other.accountId}`)).toMatch(
      /never deleted/,
    )
    expect(await broke(sql`DELETE FROM fact WHERE account_id = ${other.accountId}`)).toMatch(
      /never deleted/,
    )
    // A turn still holds versions and requests, so the database refuses it for that before the guard is asked.
    await broke(sql`DELETE FROM turn WHERE account_id = ${other.accountId}`)
    expect((await rows(other.accountId)).find((r) => r.t === 'turn')?.n).toBe(2)
  })

  it('does not let a transaction that names one account delete another’s rows', async () => {
    const mine = await seed()
    const theirs = await seed()
    await filled(theirs)
    const run = sql.begin(async (tx) => {
      await tx`SELECT set_config('warren.erasing', ${String(mine.accountId)}, true)`
      await tx`DELETE FROM movement WHERE account_id = ${theirs.accountId}`
    })
    expect(await broke(run)).toMatch(/never deleted/)
    expect((await rows(theirs.accountId)).find((r) => r.t === 'movement')?.n).toBe(2)
  })
})

describe('the platform', () => {
  it(`runs on ${realPostgres ? 'a real Postgres' : 'PGlite'} with scale(), plpgsql and a generated column`, async () => {
    const [v] = await sql<
      { v: string; scale: number }[]
    >`SELECT version() AS v, scale(1.25)::int AS scale`
    expect(v?.scale).toBe(2)
    expect(v?.v).toMatch(realPostgres ? /PostgreSQL 17/ : /PostgreSQL/)
  })
})
