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
