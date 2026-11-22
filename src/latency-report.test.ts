import { describe, expect, it } from 'vitest'
import { fetchLatencyRows, percentile, renderLatency } from './latency-report'
import { messageBody, post, row, settle, setup, sql, useDatabase } from './test-harness'
import type { Timings } from './timings'

useDatabase()

describe('stored timings', () => {
  it('a one-turn message stores every stage once its reply is sent, and its trace', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.T1'))
    await settle()
    const t = (await row('wamid.T1'))?.timings as Timings
    expect(t.claimed_ms).toBeGreaterThanOrEqual(0)
    expect(t.reads_ms).toBeGreaterThanOrEqual(0)
    expect(t.stamp_ms).toBeGreaterThanOrEqual(0)
    expect(t.send_ms).toBeGreaterThanOrEqual(0)
    expect(t.commit_ms).toBeGreaterThanOrEqual(0)
    expect(t.model_ms).toBeGreaterThanOrEqual(0)
    expect(t.media_ms).toBeUndefined() // a text message waits for no media
    expect(t.turns).toHaveLength(1)
    expect(t.turns?.[0]).toMatchObject({
      find_ms: 0,
      input: 10,
      output: 10,
      cache_read: 0,
      cache_write: 0,
    })
    app.close()
  })

  it('a message that fails keeps the stages it had: the claim, the reads and every model call it made', async () => {
    const app = await setup({
      deadlineMs: 60_000,
      model: { client: undefined as never, calls: { n: 0 }, requests: [] },
    })
    await post(app.base, messageBody('wamid.T2'))
    await settle()
    const r = await row('wamid.T2')
    expect(r?.status).toBe('failed')
    expect((r?.timings as Timings | null)?.claimed_ms).toBeGreaterThanOrEqual(0)
    app.close()
  })
})

describe('pnpm latency report', () => {
  const timed = (reply: number, timings: Timings | null) => ({
    kind: 'text',
    typing: 400,
    reply,
    delivered: null,
    model: 1000,
    type: 'log',
    turns: 1,
    timings,
  })

  it('reads old rows (no stages) without failing, and says so', () => {
    expect(renderLatency([timed(2000, null)]).join('\n')).toContain(
      'no message has stored stages yet',
    )
  })

  it('splits received -> reply into stages and leaves the rest as "other"', () => {
    const text = renderLatency([
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
    ]).join('\n')
    // 2000 - (50 + 20 + 1200 + 30 + 10 + 600) = 90
    expect(text).toMatch(/other \(rest of received -> sent\)\s+p50\s+90 ms/)
    expect(text).toMatch(/context reads \(db\)\s+p50\s+20 ms/)
    expect(text).toMatch(/Graph send\s+p50\s+600 ms/)
    expect(text).toContain('prompt cache misses (first call read nothing): 0 of 1')
  })

  it('percentile is the nearest rank and ignores nulls', () => {
    expect(percentile([null, 10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([null], 50)).toBeNull()
  })

  it('runs against the real tables: the query reads the stored stages and the turn label of a message', async () => {
    const app = await setup()
    await post(app.base, messageBody('wamid.T3'))
    await settle()
    const rows = await fetchLatencyRows(sql, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'log', kind: 'text' })
    expect(Number(rows[0]?.turns)).toBe(1)
    expect(rows[0]?.timings?.turns).toHaveLength(1)
    expect(renderLatency(rows).join('\n')).toContain(
      'Where the time goes (1 messages with stored stages',
    )
    app.close()
  })
})
