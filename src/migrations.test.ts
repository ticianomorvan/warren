import { readdir, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { describe, expect, it } from 'vitest'
import { connect, migrate } from './db'

const dir = new URL('./migrations/', import.meta.url)

describe('migration 009 (undo)', () => {
  it('applies on top of 001 to 008 with data in every state, and leaves every row as it was', async () => {
    const pg = await PGlite.create()
    const socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 4 })
    await socket.start()
    const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
    const sql = connect(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 })
    try {
      // A database as production has it: 001 to 008 applied and recorded.
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
      const old = files.filter((f) => f < '009')
      expect(old).toHaveLength(8)
      await sql`CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
      for (const name of old) {
        await sql.unsafe(await readFile(new URL(name, dir), 'utf8'))
        await sql`INSERT INTO schema_migration (name) VALUES (${name})`
      }
      // One of each: a live log, a corrected one and its correction, a deleted one.
      await sql`INSERT INTO account (wa_id) VALUES ('5491100000000')`
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, action, reply_text)
        VALUES ('m1', '5491100000000', 'text', 'x', '{}'::jsonb, 'done', 'log', '✓'),
               ('m2', '5491100000000', 'text', 'y', '{}'::jsonb, 'done', 'correct', '✓'),
               ('m3', '5491100000000', 'text', 'z', '{}'::jsonb, 'done', 'delete', '✓')`
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
          occurred_on, description, category, confidence)
        VALUES (1, 1, 0, 'out', 3500, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high'),
               (1, 1, 1, 'out', 5000, 'ARS', '2026-11-20', 'súper', 'supermercado', 'high'),
               (1, 2, 0, 'out', 3800, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high')`
      await sql`UPDATE movement SET superseded_by = 3 WHERE id = 1`
      await sql`UPDATE movement SET deleted_at = now(), deleted_by = 3 WHERE id = 2`
      const snapshot = () =>
        sql`SELECT id::int AS id, amount::text AS amount, superseded_by::int AS superseded_by,
          deleted_by::int AS deleted_by, (superseded_by IS NULL AND deleted_at IS NULL) AS live FROM movement ORDER BY id`
      const messages = () =>
        sql`SELECT id::int AS id, wamid, status, action, reply_text FROM inbound_message ORDER BY id`
      const before = { movements: await snapshot(), messages: await messages() }
      expect(before.movements.map((r) => r.live)).toEqual([false, false, true])

      await migrate(sql) // applies 009 only
      const applied = await sql`SELECT name FROM schema_migration ORDER BY name`
      expect(applied.map((r) => r.name)).toEqual(files)

      // Existing rows are valid and unchanged; the new columns are unset.
      expect(await snapshot()).toEqual(before.movements)
      expect(await messages()).toEqual(before.messages)
      const extra = await sql`SELECT
        (SELECT count(*)::int FROM movement WHERE restores IS NOT NULL) AS restores,
        (SELECT count(*)::int FROM inbound_message WHERE undoes IS NOT NULL) AS undoes`
      expect(extra[0]).toEqual({ restores: 0, undoes: 0 })
      // The constraints are in force: a message cannot undo itself, a batch is undone once, a row is restored once.
      await expect(sql`UPDATE inbound_message SET undoes = id WHERE id = 1`).rejects.toThrow()
      await sql`UPDATE inbound_message SET undoes = 1 WHERE id = 2`
      await expect(sql`UPDATE inbound_message SET undoes = 1 WHERE id = 3`).rejects.toThrow()
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
          occurred_on, description, category, confidence, restores)
        VALUES (1, 3, 0, 'out', 5000, 'ARS', '2026-11-20', 'súper', 'supermercado', 'high', 2)`
      await expect(
        sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
          occurred_on, description, category, confidence, restores)
        VALUES (1, 3, 1, 'out', 5000, 'ARS', '2026-11-20', 'súper', 'supermercado', 'high', 2)`,
      ).rejects.toThrow()
      await migrate(sql) // idempotent
    } finally {
      await sql.end({ timeout: 1 })
      await socket.stop()
      await pg.close()
    }
  })
})

describe('migration 011 (facts)', () => {
  it('applies on top of 001 to 010 with data in every state, leaves every row as it was, and enforces its rules', async () => {
    const pg = await PGlite.create()
    const socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 4 })
    await socket.start()
    const port = (socket as unknown as { server: { address(): AddressInfo } }).server.address().port
    const sql = connect(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 })
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
      const old = files.filter((f) => f < '011')
      expect(old).toHaveLength(10)
      await sql`CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
      for (const name of old) {
        await sql.unsafe(await readFile(new URL(name, dir), 'utf8'))
        await sql`INSERT INTO schema_migration (name) VALUES (${name})`
      }
      // A database as production has it: a log, a correction, a delete and an undo.
      await sql`INSERT INTO account (wa_id) VALUES ('5491100000000'), ('5491100000001')`
      await sql`INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, status, action, reply_text)
        VALUES ('m1', '5491100000000', 'text', 'x', '{}'::jsonb, 'done', 'log', '✓'),
               ('m2', '5491100000000', 'text', 'y', '{}'::jsonb, 'done', 'correct', '✓'),
               ('m3', '5491100000000', 'text', 'z', '{}'::jsonb, 'done', 'undo', '↩︎')`
      await sql`INSERT INTO movement (account_id, inbound_message_id, position, direction, amount, currency,
          occurred_on, description, category, confidence)
        VALUES (1, 1, 0, 'out', 3500, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high'),
               (1, 2, 0, 'out', 3800, 'ARS', '2026-11-20', 'café', 'restaurantes', 'high')`
      await sql`UPDATE movement SET superseded_by = 2 WHERE id = 1`
      await sql`UPDATE inbound_message SET undoes = 1 WHERE id = 3`
      const snapshot = async () => ({
        movements:
          await sql`SELECT id::int AS id, amount::text AS amount, superseded_by::int AS superseded_by,
          restores::int AS restores FROM movement ORDER BY id`,
        messages:
          await sql`SELECT id::int AS id, wamid, status, action, reply_text, undoes::int AS undoes
          FROM inbound_message ORDER BY id`,
        accounts: await sql`SELECT id::int AS id, wa_id FROM account ORDER BY id`,
      })
      const before = await snapshot()

      await migrate(sql) // applies 011 only
      const applied = await sql`SELECT name FROM schema_migration ORDER BY name`
      expect(applied.map((r) => r.name)).toEqual(files)
      expect(await snapshot()).toEqual(before)
      expect((await sql`SELECT count(*)::int AS n FROM fact`)[0]?.n).toBe(0)

      const add = (account: number, key: string, value = 'v', kind = 'alias') =>
        sql`INSERT INTO fact (account_id, kind, key, value, inbound_message_id)
          VALUES (${account}, ${kind}, ${key}, ${value}, 1) RETURNING id::int AS id`
      const [first] = await add(1, 'la visa', 'galicia')
      // One live fact per account, kind and key; the same key of another account, or of another kind, is another fact.
      await expect(add(1, 'la visa', 'santander')).rejects.toThrow()
      await add(2, 'la visa', 'santander')
      await add(1, 'la visa', 'santander', 'note')
      // Replacing it: the old row points at the new one first (the pointer is deferred), then the new one is inserted.
      const [next] = await sql`SELECT nextval(pg_get_serial_sequence('fact', 'id'))::int AS id`
      await sql.begin(async (tx) => {
        await tx`UPDATE fact SET superseded_by = ${next?.id as number} WHERE id = ${first?.id as number}`
        await tx`INSERT INTO fact (id, account_id, kind, key, value, inbound_message_id)
          VALUES (${next?.id as number}, 1, 'alias', 'la visa', 'santander', 2)`
      })
      // Forgetting: stamped together with the message that asked; a row is not both replaced and forgotten.
      await expect(
        sql`UPDATE fact SET forgotten_at = now() WHERE id = ${next?.id as number}`,
      ).rejects.toThrow()
      await sql`UPDATE fact SET forgotten_at = now(), forgotten_by = 3 WHERE id = ${next?.id as number}`
      await expect(
        sql`UPDATE fact SET forgotten_at = now(), forgotten_by = 3 WHERE id = ${first?.id as number}`,
      ).rejects.toThrow()
      // A forgotten fact can be restored once, by a new row.
      const restore = (n: number) =>
        sql`INSERT INTO fact (account_id, kind, key, value, inbound_message_id, restores)
          VALUES (1, 'alias', 'la visa', ${`r${n}`}, 3, ${next?.id as number})`
      await sql.begin(async (tx) => {
        await tx`INSERT INTO fact (account_id, kind, key, value, inbound_message_id, restores)
          VALUES (1, 'alias', 'la visa', 'santander', 3, ${next?.id as number})`
      })
      await expect(restore(2)).rejects.toThrow()
      // The checks of what a fact may hold.
      await expect(add(1, 'otra', 'v', 'secreto')).rejects.toThrow()
      await expect(add(1, '', 'v')).rejects.toThrow()
      await expect(add(1, 'x'.repeat(41), 'v')).rejects.toThrow()
      await expect(add(1, 'otra', 'y'.repeat(101))).rejects.toThrow()
      await migrate(sql) // idempotent
    } finally {
      await sql.end({ timeout: 1 })
      await socket.stop()
      await pg.close()
    }
  })
})
