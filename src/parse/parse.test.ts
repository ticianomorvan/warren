import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { parseMessage } from './index'

function stubClient(parsed: unknown, usage: Record<string, number | null>) {
  const calls: unknown[] = []
  const client = {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params)
        return { parsed_output: parsed, stop_reason: 'end_turn', usage }
      },
    },
  } as unknown as Anthropic
  return { client, calls }
}

const log = {
  type: 'log',
  movements: [
    {
      direction: 'out',
      amount: '3.500',
      currency: 'ARS',
      date: '2026-11-25',
      description: 'café',
      category: 'restaurantes',
      payment: null,
      confidence: 'high',
    },
  ],
}

describe('parseMessage', () => {
  it('validates after the model, maps usage and sends a cached frozen prefix', async () => {
    const { client, calls } = stubClient(log, {
      input_tokens: 400,
      output_tokens: 120,
      cache_read_input_tokens: 7000,
      cache_creation_input_tokens: null,
    })
    const result = await parseMessage({
      text: 'cafe 3.500',
      today: '2026-11-20',
      recentMovements: [],
      model: 'haiku',
      client,
    })
    expect(result.command).toMatchObject({ movements: [{ amount: '3.500', confidence: 'low' }] })
    expect(result.issues).toHaveLength(2)
    expect(result.usage).toEqual({
      inputTokens: 400,
      outputTokens: 120,
      cacheReadTokens: 7000,
      cacheWriteTokens: 0,
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(calls[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: [{ cache_control: { type: 'ephemeral' } }],
    })
  })

  it('uses between_tools thinking for sonnet', async () => {
    const { client, calls } = stubClient({ type: 'help' }, { input_tokens: 1, output_tokens: 1 })
    await parseMessage({
      text: 'hola',
      today: '2026-11-20',
      recentMovements: [],
      model: 'sonnet',
      client,
    })
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    })
  })

  it('throws when the model returns nothing parsable', async () => {
    const { client } = stubClient(null, { input_tokens: 1, output_tokens: 1 })
    await expect(
      parseMessage({ text: 'x', today: '2026-11-20', recentMovements: [], model: 'haiku', client }),
    ).rejects.toThrow('no parsable command')
  })
})
