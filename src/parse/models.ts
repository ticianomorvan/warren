import type Anthropic from '@anthropic-ai/sdk'

export type ModelKey = 'haiku' | 'sonnet'

export type ModelConfig = {
  id: string
  effort: 'low'
  thinking: Anthropic.ThinkingConfigParam
  /** US$ per million tokens (claude-api skill price table, cached 2026-11-03). */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export const MODELS: Record<ModelKey, ModelConfig> = {
  // Thinking can be turned off only at effort `high` or below.
  haiku: {
    id: 'claude-haiku-5-5',
    effort: 'low',
    thinking: { type: 'disabled' },
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  // On Sonnet 5.5 `disabled` is a 400; `between_tools` is its way of not thinking up front.
  sonnet: {
    id: 'claude-sonnet-5-5',
    effort: 'low',
    thinking: { type: 'between_tools' },
    price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
}

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function estimateCostUsd(model: ModelKey, usage: Usage): number {
  const { price } = MODELS[model]
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  )
}
