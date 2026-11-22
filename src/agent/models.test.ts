import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from './models'

describe('estimateCostUsd (Haiku 5.5: US$0.10 in, 0.50 out, cache read 0.01, 5-minute write 0.125, 1-hour write 0.20)', () => {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  }
  const usd = (u: Partial<typeof zero>) => estimateCostUsd('haiku', { ...zero, ...u })

  it('prices each kind of token', () => {
    expect(usd({ inputTokens: 1_000_000 })).toBeCloseTo(0.1, 10)
    expect(usd({ outputTokens: 1_000_000 })).toBeCloseTo(0.5, 10)
    expect(usd({ cacheReadTokens: 1_000_000 })).toBeCloseTo(0.01, 10)
  })

  it('prices a cache write by its TTL: the 1-hour tokens are part of the written total, at 2x the input price', () => {
    expect(usd({ cacheWriteTokens: 1_000_000 })).toBeCloseTo(0.125, 10)
    expect(usd({ cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(0.2, 10)
    // Half and half: the 1-hour part is not charged twice.
    expect(usd({ cacheWriteTokens: 2_000_000, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(
      0.325,
      10,
    )
  })

  it('writing the production prefix (17,240 tokens) costs 12.5x reading it', () => {
    const miss5m = usd({ cacheWriteTokens: 17_240 })
    const miss1h = usd({ cacheWriteTokens: 17_240, cacheWrite1hTokens: 17_240 })
    const hit = usd({ cacheReadTokens: 17_240 })
    expect(miss5m / hit).toBeGreaterThan(12)
    expect(miss1h).toBeGreaterThan(miss5m)
    expect(hit).toBeCloseTo(0.0001724, 8)
  })
})
