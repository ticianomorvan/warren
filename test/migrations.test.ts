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

let n = 0
/** A person, an address and the turn a version is made in. */
async function seed() {
  n += 1
  const [account] = await sql<
    { id: number }[]
  >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
  await sql`INSERT INTO account_address (account_id, channel, address) VALUES (${account?.id ?? 0}, 'whatsapp', ${`54911${n}`})`
  const accountId = account?.id ?? 0
  return { accountId, turn: () => newTurn(accountId) }
}
async function newTurn(accountId: number): Promise<number> {
  const [t] = await sql<{ id: number }[]>`
    INSERT INTO turn (account_id, channel, label, reply) VALUES (${accountId}, 'whatsapp', 'log', '✓') RETURNING id::int AS id`
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
async function newReminder(accountId: number, madeIn: number) {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO reminder (account_id, made_in, what, schedule, next_due_at)
    VALUES (${accountId}, ${madeIn}, 'pagar la luz', ${sql.json({ kind: 'once' })}, now() + interval '1 day') RETURNING id::int AS id`
  return r?.id ?? 0
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
        'account_address',
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
        'link_request',
        'mcp_request',
        'movement',
        'reminder',
        'reminder_send',
        'reply',
        'turn',
        'wa_message',
      ].sort(),
    )
    expect(tables.filter((t) => !t.comment).map((t) => t.name)).toEqual([])
  })

  it('has everything better-auth 1.7.26 and its plugins want: no table or column is missing', async () => {
    const auth = createAuth({
      sql,
      publicUrl: 'https://example.test',
      secret: 'x'.repeat(40),
      links: { spend: async () => null },
    })
    const plan = await getMigrations(auth.options)
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([])
    expect(plan.toBeAdded.map((t) => t.table)).toEqual([])
    expect(plan.schemaProblems).toEqual([])
  })
})

describe('accounts and addresses', () => {
  it('refuses a second account claiming an address', async () => {
    const { accountId } = await seed()
    const [other] = await sql<
      { id: number }[]
    >`INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
    const [taken] = await sql<
      { address: string }[]
    >`SELECT address FROM account_address WHERE account_id = ${accountId}`
    expect(
      await broke(
        sql`INSERT INTO account_address (account_id, channel, address) VALUES (${other?.id ?? 0}, 'whatsapp', ${taken?.address ?? ''})`,
      ),
    ).toBe('account_address_one_owner')
  })
})

describe('turn', () => {
  it('refuses a turn that undoes itself', async () => {
    const { accountId } = await seed()
    expect(
      await broke(
        sql`INSERT INTO turn (id, account_id, channel, label, reply, undoes) VALUES (987654, ${accountId}, 'whatsapp', 'undo', 'x', 987654)`,
      ),
    ).toBe('turn_undoes_other')
  })

  it('refuses a second undo of the same turn', async () => {
    const s = await seed()
    const target = await s.turn()
    await sql`INSERT INTO turn (account_id, channel, label, reply, undoes) VALUES (${s.accountId}, 'whatsapp', 'undo', 'x', ${target})`
    expect(
      await broke(
        sql`INSERT INTO turn (account_id, channel, label, reply, undoes) VALUES (${s.accountId}, 'mcp', 'undo', 'x', ${target})`,
      ),
    ).toBe('turn_undoes_once')
  })

  it('refuses an unknown channel', async () => {
    const { accountId } = await seed()
    expect(
      await broke(
        sql`INSERT INTO turn (account_id, channel, label, reply) VALUES (${accountId}, 'telegram', 'log', 'x')`,
      ),
    ).toBe('turn_channel_known')
  })

  it('holds one answer per request id and refuses a second turn for the same message', async () => {
    const s = await seed()
    const t = await s.turn()
    await sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r1', 'h', ${t}, '{}')`
    expect(
      await broke(
        sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r1', 'h', ${t}, '{}')`,
      ),
    ).toBe('mcp_request_pkey')
    await sql`INSERT INTO wa_message (wamid, wa_id, kind, turn_id) VALUES ('w1', '1', 'text', ${t})`
    expect(
      await broke(
        sql`INSERT INTO wa_message (wamid, wa_id, kind, turn_id) VALUES ('w2', '1', 'text', ${t})`,
      ),
    ).toBe('wa_message_turn_once')
    expect(
      await broke(sql`INSERT INTO wa_message (wamid, wa_id, kind) VALUES ('w1', '1', 'text')`),
    ).toBe('wa_message_wamid_unique')
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
    const r = await newReminder(s.accountId, t)
    expect(await broke(sql`UPDATE reminder SET ended_at = now() WHERE id = ${r}`)).toBe(
      'reminder_ended_pair',
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
    expect(row?.n).toBe(5)
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
    const r = await newReminder(s.accountId, t)
    expect(await broke(sql`UPDATE reminder SET what = 'otra cosa' WHERE id = ${r}`)).toMatch(
      /append-only/,
    )
    expect(await broke(sql`UPDATE turn SET reply = 'x' WHERE id = ${t}`)).toMatch(/append-only/)
    await sql`INSERT INTO mcp_request (account_id, request_id, input_hash, turn_id, result) VALUES (${s.accountId}, 'r-guard', 'h', ${t}, '{}')`
    expect(
      await broke(sql`UPDATE mcp_request SET result = '{"a":1}' WHERE request_id = 'r-guard'`),
    ).toMatch(/append-only/)
  })

  it('rejects a DELETE', async () => {
    const s = await seed()
    const t = await s.turn()
    const m = await newMovement(s.accountId, t)
    expect(await broke(sql`DELETE FROM movement WHERE id = ${m.id}`)).toMatch(/never deleted/)
    expect(await broke(sql`DELETE FROM turn WHERE id = ${await s.turn()}`)).toMatch(/never deleted/)
  })

  it('allows the ended pair, once, and next_due_at on a reminder', async () => {
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

    const r = await newReminder(s.accountId, t1)
    await sql`UPDATE reminder SET next_due_at = now() + interval '2 days' WHERE id = ${r}`
    await sql`UPDATE reminder SET next_due_at = NULL WHERE id = ${r}`
    await sql`UPDATE reminder SET ended_in = ${t2}, ended_at = now() WHERE id = ${r}`
    const [row] = await sql<
      { ended: boolean; due: Date | null }[]
    >`SELECT ended_at IS NOT NULL AS ended, next_due_at AS due FROM reminder WHERE id = ${r}`
    expect(row).toEqual({ ended: true, due: null })

    const [f] = await sql<{ id: number }[]>`
      INSERT INTO fact (account_id, made_in, kind, key, value) VALUES (${s.accountId}, ${t1}, 'note', 'cobro2', 'el 5') RETURNING id::int AS id`
    await sql`UPDATE fact SET ended_in = ${t2}, ended_at = now() WHERE id = ${f?.id ?? 0}`
  })

  it('does not allow next_due_at on a movement or a fact', async () => {
    // next_due_at is declared mutable state of the reminder only; the other tables have no such column to change.
    const cols = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'next_due_at'`
    expect(cols.map((c) => c.table_name)).toEqual(['reminder'])
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
