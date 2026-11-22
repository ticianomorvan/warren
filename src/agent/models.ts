import type Anthropic from '@anthropic-ai/sdk'

export type ModelKey = 'haiku' | 'sonnet'

export type ModelConfig = {
  id: string
  thinking: Anthropic.ThinkingConfigParam
  /** US$ per million tokens (claude-api skill price table, cached 2026-11-03). */
  price: {
    input: number
    output: number
    cacheRead: number
    /** Writing the cache with the default 5-minute TTL (1.25x the input price). */
    cacheWrite: number
    /** Writing it with the 1-hour TTL (2x the input price). */
    cacheWrite1h: number
  }
}

export const MODELS: Record<ModelKey, ModelConfig> = {
  // Thinking can be turned off only at effort `high` or below (the request sets `low`).
  haiku: {
    id: 'claude-haiku-5-5',
    thinking: { type: 'disabled' },
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
  },
  // Thinking differs per model on purpose: Haiku 5.5 accepts `disabled`; Sonnet 5.5 answers it with
  // a 400, and `between_tools` is its way of not thinking up front.
  sonnet: {
    id: 'claude-sonnet-5-5',
    thinking: { type: 'between_tools' },
    price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  },
}

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Every token written to the cache, whatever its TTL (the API's `cache_creation_input_tokens`). */
  cacheWriteTokens: number
  /** Of those, the ones written with the 1-hour TTL. */
  cacheWrite1hTokens: number
}

export function estimateCostUsd(model: ModelKey, usage: Usage): number {
  const { price } = MODELS[model]
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      (usage.cacheWriteTokens - usage.cacheWrite1hTokens) * price.cacheWrite +
      usage.cacheWrite1hTokens * price.cacheWrite1h) /
    1_000_000
  )
}
