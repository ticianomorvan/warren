import { describe, expect, it } from 'vitest'
import { find, replyCall, say, script, seed } from './command-fixtures'
import { RECENT_LIMIT } from './ledger'
import { createStore } from './store'
import { setup, sql, TODAY, useDatabase } from './test-harness'

useDatabase()

/** What the model was shown in its first request of the run: the last user block. */
const firstContext = (requests: { messages: { content: unknown }[] }[]) => {
  const first = requests[0]?.messages[0]?.content
  return typeof first === 'string' ? first : JSON.stringify(first)
}

const rows = (n: number) =>
  seed(
    Array.from({ length: n }, (_, k) => ({
      on: TODAY,
      amount: String(1000 + k),
      description: `cosa ${k}`,
    })),
  )

describe('the model is told when it has seen the whole ledger', () => {
  it('says so, and not to search, when the person has fewer movements than the list holds', async () => {
    await rows(3)
    const app = await setup({ model: script(replyCall('Eso no lo sé.')) })
    await say(app)
    expect(firstContext(app.requests)).toContain('toda la historia')
    expect(firstContext(app.requests)).toContain('find_movements')
    app.close()
  })

  it('does not say it for a full list (older movements may exist), nor for an empty one', async () => {
    await rows(RECENT_LIMIT)
    const full = await setup({ model: script(replyCall('Eso no lo sé.')) })
    await say(full)
    expect(firstContext(full.requests)).not.toContain('toda la historia')
    full.close()
    await sql`TRUNCATE movement, reply, inbound_message, account RESTART IDENTITY CASCADE`
    const empty = await setup({ model: script(replyCall('Eso no lo sé.')) })
    await say(empty)
    expect(firstContext(empty.requests)).not.toContain('toda la historia')
    empty.close()
  })

  it('a ledger of RECENT_LIMIT - 1 is complete; the next movement makes it full', async () => {
    await rows(RECENT_LIMIT - 1)
    const app = await setup({ model: script(replyCall('a'), replyCall('b')) })
    await say(app)
    expect(firstContext(app.requests)).toContain('toda la historia')
    app.close()
  })

  it('a search still runs when the model asks for one (the guard is advice, not a block)', async () => {
    await rows(3)
    const app = await setup({ model: script(find({ text: 'cosa' }), replyCall('Hay.')) })
    await say(app)
    expect(app.requests).toHaveLength(2)
    app.close()
  })
})

describe('upsertAccount', () => {
  it('creates the account once and returns the same id to every caller, even at once', async () => {
    const store = createStore(sql, { staleMs: 0, maxAttempts: 3 })
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => store.upsertAccount('5491100000099')),
    )
    expect(new Set(ids).size).toBe(1)
    expect(await store.upsertAccount('5491100000099')).toBe(ids[0])
    expect(Number((await sql`SELECT count(*) AS n FROM account`)[0]?.n)).toBe(1)
    expect(await store.upsertAccount('5491100000098')).not.toBe(ids[0])
  })
})
