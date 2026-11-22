import { describe, expect, it } from 'vitest'
import { cafe, log, newAccount, remind, turn } from '../../../test/core'
import { sql, useDatabase } from '../../../test/db'
import { schemaDir } from '../../core/db'
import { countLiveReminders, liveReminders } from './db'

useDatabase({ migrations: schemaDir })

describe('a stored reminder whose schedule no longer parses', () => {
  it('is left out of the list and the cap; the others still work', async () => {
    const a = await newAccount(sql)
    const t = await turn(sql, a, [
      log(cafe()),
      remind('buena', { month_day: 10 }),
      remind('otra', { month_day: 11 }),
    ])
    await sql`INSERT INTO reminder (account_id, made_in, what, schedule, next_due_at)
      VALUES (${a}, ${t.turn}, 'mala', '{"start":"nope"}'::jsonb, now() + interval '1 day')`
    expect((await liveReminders(sql, a)).map((r) => r.what)).toEqual(['buena', 'otra'])
    expect(await countLiveReminders(sql, a)).toBe(2)
  })

  it('lists the live ones, the next to come first, and not a finished one-off', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [
      remind('lejos', { month_day: 25 }),
      remind('cerca', { month_day: 10 }),
      remind('hecho', { month_day: 11 }),
    ])
    await sql`UPDATE reminder SET next_due_at = NULL WHERE what = 'hecho'`
    expect((await liveReminders(sql, a)).map((r) => r.what)).toEqual(['cerca', 'lejos'])
  })
})
