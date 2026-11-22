import { describe, expect, it } from 'vitest'
import { realPostgres, sql, useDatabase } from './db'
import { message, toolUse } from './fakes'
import { until } from './until'

useDatabase()

describe('the test kit', () => {
  it('gives the file a migrated database, empty at the start of each test', async () => {
    const [tables] = await sql`SELECT count(*)::int AS n FROM schema_migration`
    expect(tables?.n).toBeGreaterThan(0)
    expect((await sql`SELECT 1 FROM movement`).length).toBe(0)
    await sql`INSERT INTO account (wa_id) VALUES ('5491100000099')`
  })

  it('truncates between tests', async () => {
    expect((await sql`SELECT 1 FROM account`).length).toBe(0)
  })

  it('runs on the Postgres it was given, in a schema of its own', async () => {
    const [row] = await sql`SELECT current_schema() AS s`
    expect(realPostgres ? row?.s : 'public').toMatch(realPostgres ? /^t_/ : /^public$/)
  })

  it('until returns as soon as the condition holds and throws when it never does', async () => {
    let n = 0
    await until(() => ++n === 3)
    expect(n).toBe(3)
    await expect(until(() => false, { timeout: 50, what: 'nothing' })).rejects.toThrow(
      /timed out after 50 ms waiting for nothing/,
    )
  })

  it('builds Anthropic messages typed to the SDK', () => {
    const m = message([toolUse('toolu_1', 'reply', { text: 'hola' })])
    expect(m.content[0]).toMatchObject({ type: 'tool_use', name: 'reply' })
    expect(m.stop_reason).toBe('tool_use')
  })
})
