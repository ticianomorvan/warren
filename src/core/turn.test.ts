import { describe, expect, it } from 'vitest'
import { cafe, log, newAccount, turn } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { schemaDir } from './db'

useDatabase({ migrations: schemaDir })

describe('commit', () => {
  it('logs, and the turn is the commit point', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [log(cafe())])
    expect(t.reply).toBe('✓ Café $3.500')
    const rows = await sql`SELECT made_in::int AS made_in, entity_id::int AS entity FROM movement`
    expect(rows).toEqual([{ made_in: t.turn, entity: 1 }])
    const [row] = await sql`SELECT label, record, reply FROM turn WHERE id = ${t.turn}`
    expect(row).toEqual({ label: 'log', record: '✓ Café $3.500', reply: '✓ Café $3.500' })
  })
})
