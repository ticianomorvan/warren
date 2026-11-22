import { describe, expect, it } from 'vitest'
import { find, logOf, movement, replyCall, say, script, seed } from './command-fixtures'
import { fetchLatencyRows, type LatencyRow, percentile, renderLatency } from './latency-report'
import {
  fakeGraph,
  fakeModel,
  fakeTranscriber,
  heard,
  post,
  row,
  seed as seedInbound,
  setup,
  sql,
  TODAY,
  until,
  useDatabase,
  voiceBody,
} from './test-harness'
import type { Timings } from './timings'

useDatabase()

const timingsOf = async (wamid: string) => (await row(wamid))?.timings as Timings | null

describe('stored timings', () => {
  it('a one-turn message stores every stage, in order, once its reply is sent', async () => {
    const app = await setup({ model: script(logOf(movement())) })
    await say(app)
    const [r] = await sql`SELECT * FROM inbound_message ORDER BY id DESC LIMIT 1`
    const t = r?.timings as Timings
    expect(t.claimed_ms).toBeGreaterThanOrEqual(0)
    expect(t.reads_ms).toBeGreaterThanOrEqual(0)
    expect(t.commit_ms).toBeGreaterThanOrEqual(0)
    expect(t.stamp_ms).toBeGreaterThanOrEqual(0)
    expect(t.send_ms).toBeGreaterThanOrEqual(0)
    expect(t.media_ms).toBeUndefined() // a text message waits for no media
    // One turn: its call time, the reads that followed (none), and the tokens the response reported.
    expect(t.turns).toHaveLength(1)
    expect(t.turns?.[0]).toMatchObject({
      find_ms: 0,
      input: 10,
      output: 10,
      cache_read: 0,
      cache_write: 0,
      text_chars: 0,
    })
    expect(t.turns?.[0]?.model_ms).toBeGreaterThanOrEqual(0)
    // The existing columns are untouched by the new one.
    expect(r?.model_turns).toBe(1)
    app.close()
  })

  it('a search then an action stores two turns, and the search time is on the first', async () => {
    await seed([{ on: TODAY, amount: '1000', description: 'alquiler' }])
    const app = await setup({
      model: script(find({ text: 'alquiler' }), replyCall('Lo tengo anotado.')),
      // The search takes 40 ms: its time must show on the turn that ran it, and only there.
      processorStore: (store) => ({
        ...store,
        find: async (...args: Parameters<typeof store.find>) => {
          await new Promise((r) => setTimeout(r, 40))
          return store.find(...args)
        },
      }),
    })
    await say(app)
    const [r] =
      await sql`SELECT timings FROM inbound_message WHERE reply_text IS NOT NULL ORDER BY id DESC LIMIT 1`
    const t = r?.timings as Timings
    expect(t.turns).toHaveLength(2)
    expect(t.turns?.[0]?.find_ms).toBeGreaterThanOrEqual(35)
    expect(t.turns?.[1]?.find_ms).toBe(0)
    app.close()
  })

  it('adds up the searches of a turn, and times each model call from its own start', async () => {
    await seed([{ on: TODAY, amount: '1000', description: 'alquiler' }])
    let n = 0
    const model = fakeModel(async () => {
      n++
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 60)) // a slow first call
        return [find({ text: 'alquiler' }), find({ text: 'cosa' })]
      }
      return [replyCall('Lo tengo anotado.')]
    })
    const app = await setup({
      model,
      processorStore: (store) => ({
        ...store,
        find: async (...args: Parameters<typeof store.find>) => {
          await new Promise((r) => setTimeout(r, 40))
          return store.find(...args)
        },
      }),
    })
    await say(app)
    const [r] =
      await sql`SELECT timings FROM inbound_message WHERE reply_text IS NOT NULL ORDER BY id DESC LIMIT 1`
    const t = r?.timings as Timings
    // Two searches of 40 ms each, run one after the other: both count on turn 1.
    expect(t.turns?.[0]?.find_ms).toBeGreaterThanOrEqual(75)
    expect(t.turns?.[0]?.model_ms).toBeGreaterThanOrEqual(55)
    // The second call is quick: it must not carry the first call or its searches.
    expect(t.turns?.[1]?.model_ms).toBeLessThan(40)
    app.close()
  })

  it('times the commit, the send and the wait before the claim', async () => {
    const app = await setup({
      model: script(logOf(movement())),
      fake: fakeGraph({
        send: async (k) => {
          await new Promise((r) => setTimeout(r, 50))
          return `wamid.OUT${k}`
        },
      }),
      processorStore: (store) => ({
        ...store,
        commit: async (...args: Parameters<typeof store.commit>) => {
          await new Promise((r) => setTimeout(r, 40))
          return store.commit(...args)
        },
      }),
    })
    // A message that has been waiting 5 s when the sweep claims it.
    await seedInbound('wamid.OLD', "status = 'pending', received_at = now() - interval '5 seconds'")
    await app.processor.sweep()
    await until(async () => (await row('wamid.OLD'))?.status === 'done')
    const t = await timingsOf('wamid.OLD')
    expect(t?.claimed_ms).toBeGreaterThanOrEqual(4900)
    expect(t?.commit_ms).toBeGreaterThanOrEqual(35)
    expect(t?.send_ms).toBeGreaterThanOrEqual(45)
    app.close()
  })

  it('a voice note stores how long its download and transcription took', async () => {
    const { transcriber } = fakeTranscriber(heard('café 3500'))
    const app = await setup({ model: script(logOf(movement())), transcriber })
    // (the fake Graph serves no media by id: the note is answered with a notice, still with stages)
    await post(app.base, voiceBody('wamid.VOICE1', 'media1'))
    await until(async () => (await row('wamid.VOICE1'))?.status === 'done')
    const t = await timingsOf('wamid.VOICE1')
    expect(t?.media_ms).toBeGreaterThanOrEqual(0)
    expect(t?.turns).toEqual([])
    app.close()
  })

  it('a sent reply keeps timings already stored (the merge never wipes them)', async () => {
    const app = await setup({ model: script(logOf(movement())) })
    await say(app)
    const [r] = await sql`SELECT id FROM inbound_message ORDER BY id DESC LIMIT 1`
    // A resend path writes only its own stages: the earlier ones stay.
    await sql`UPDATE inbound_message SET status = 'processing' WHERE id = ${r?.id}`
    await app.store.recordReplySent({ id: Number(r?.id), attempts: 1 } as never, 'wamid.X', {
      claimed_ms: 1,
      send_ms: 7,
    })
    const t = (await sql`SELECT timings FROM inbound_message WHERE id = ${r?.id}`)[0]
      ?.timings as Timings
    expect(t.send_ms).toBe(7)
    expect(t.turns).toHaveLength(1)
    app.close()
  })
})

const timed = (
  reply: number,
  t: Partial<Timings> & { claimed_ms: number },
  type = 'log',
): LatencyRow => ({
  typing: 400,
  reply,
  delivered: null,
  model: null,
  type,
  turns: 1,
  timings: t as Timings,
})

describe('pnpm latency report', () => {
  it('reads old rows (no stages) without failing, and says so', () => {
    const lines = renderLatency([
      {
        typing: 400,
        reply: 2000,
        delivered: null,
        model: 1500,
        type: 'log',
        turns: 1,
        timings: null,
      },
    ])
    expect(lines.join('\n')).toContain('no message has stored stages yet')
  })

  it('splits received -> reply into stages and leaves the rest as "other"', () => {
    const rows = [
      timed(2000, {
        claimed_ms: 50,
        reads_ms: 20,
        turns: [
          {
            model_ms: 1200,
            find_ms: 0,
            input: 900,
            output: 150,
            cache_read: 13000,
            cache_write: 0,
            text_chars: 0,
          },
        ],
        commit_ms: 30,
        stamp_ms: 10,
        send_ms: 600,
      }),
    ]
    const text = renderLatency(rows).join('\n')
    // 2000 - (50 + 20 + 1200 + 30 + 10 + 600) = 90
    expect(text).toMatch(/other \(rest of received -> sent\)\s+p50\s+90 ms/)
    expect(text).toMatch(/context reads \(db\)\s+p50\s+20 ms/)
    expect(text).toMatch(/Graph send\s+p50\s+600 ms/)
    expect(text).toMatch(/output tokens\s+p50\s+150 tok/)
    expect(text).toContain('prompt cache misses (first call read nothing): 0 of 1')
  })

  it('counts a first call that read nothing as a cache miss, and times it apart', () => {
    const turn = (read: number, ms: number) => ({
      model_ms: ms,
      find_ms: 0,
      input: 10,
      output: 100,
      cache_read: read,
      cache_write: read === 0 ? 14000 : 0,
      text_chars: 0,
    })
    const rows = [
      timed(2500, {
        claimed_ms: 5,
        reads_ms: 5,
        turns: [turn(0, 2600)],
        commit_ms: 5,
        stamp_ms: 5,
        send_ms: 5,
      }),
      timed(1500, {
        claimed_ms: 5,
        reads_ms: 5,
        turns: [turn(14000, 1200)],
        commit_ms: 5,
        stamp_ms: 5,
        send_ms: 5,
      }),
    ]
    const text = renderLatency(rows).join('\n')
    expect(text).toContain('prompt cache misses (first call read nothing): 1 of 2')
    expect(text).toMatch(/turn 1 model call, cache miss\s+p50\s+2600 ms/)
    expect(text).toMatch(/turn 1 model call, cache hit\s+p50\s+1200 ms/)
  })

  it('sums the calls after the first and the search reads of every turn', () => {
    const rows = [
      timed(
        4000,
        {
          claimed_ms: 5,
          reads_ms: 5,
          turns: [
            {
              model_ms: 1000,
              find_ms: 40,
              input: 1,
              output: 80,
              cache_read: 1,
              cache_write: 0,
              text_chars: 0,
            },
            {
              model_ms: 1500,
              find_ms: 0,
              input: 1,
              output: 200,
              cache_read: 1,
              cache_write: 0,
              text_chars: 0,
            },
          ],
          commit_ms: 5,
          stamp_ms: 5,
          send_ms: 5,
        },
        'ask',
      ),
    ]
    const text = renderLatency(rows).join('\n')
    expect(text).toMatch(/model calls after turn 1\s+p50\s+1500 ms/)
    expect(text).toMatch(/find_movements reads\s+p50\s+40 ms/)
    expect(text).toMatch(/agent loop \(model \+ reads\)\s+p50\s+2540 ms/)
    expect(text).toMatch(/ask\s+mean output\s+280 tok/)
  })

  it('percentile is the nearest rank and ignores nulls', () => {
    expect(percentile([null, 10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([null], 50)).toBeNull()
  })

  it('runs against the real table: the query reads the stored stages of a message', async () => {
    const app = await setup({ model: script(logOf(movement())) })
    await say(app)
    const rows = await fetchLatencyRows(sql, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.timings?.turns).toHaveLength(1)
    const text = renderLatency(rows).join('\n')
    expect(text).toContain('Where the time goes (1 messages with stored stages')
    app.close()
  })
})
