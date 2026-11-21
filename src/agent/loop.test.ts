import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import type { MovementRow } from '../ledger'
import { AgentError, MAX_TURNS, runAgent, warmUp } from './loop'
import { SYSTEM_PROMPT } from './prompt'
import { TOOLS } from './tools'

type Call = { name: string; input: unknown }
const movement = (o: object = {}) => ({
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: '2026-11-21',
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
  ...o,
})
const log = (...m: object[]): Call => ({
  name: 'log_movements',
  input: { movements: m.length ? m : [movement()] },
})
const correct = (id: number, changes: object): Call => ({
  name: 'correct_movement',
  input: { id, changes },
})
const del = (id: number): Call => ({ name: 'delete_movement', input: { id } })
const find = (input: object = {}): Call => ({ name: 'find_movements', input })

const row = (id: number, o: Partial<MovementRow> = {}): MovementRow => ({
  id,
  direction: 'out',
  amount: '1000',
  currency: 'ARS',
  date: '2026-11-01',
  description: 'alquiler',
  category: 'vivienda',
  payment: null,
  time: '09:00',
  ...o,
})

/** A client that answers each request with the next scripted turn (text-only when it is a string). */
function client(...turns: (Call[] | string)[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  const signals: (AbortSignal | undefined)[] = []
  const c = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ) => {
        requests.push(structuredClone(params))
        signals.push(options?.signal)
        const turn = turns[requests.length - 1] ?? []
        return {
          content:
            typeof turn === 'string'
              ? [{ type: 'text', text: turn }]
              : turn.map((t, k) => ({ type: 'tool_use', id: `t${requests.length}_${k}`, ...t })),
          stop_reason: typeof turn === 'string' ? 'end_turn' : 'tool_use',
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
          },
        }
      },
    },
  } as unknown as Anthropic
  return { c, requests, signals }
}

const run = (
  c: Anthropic,
  o: { seen?: number[]; find?: (id: number) => MovementRow[]; signal?: AbortSignal } = {},
) =>
  runAgent({
    client: c,
    model: 'haiku',
    context: 'ctx',
    today: '2026-11-21',
    env: { find: async () => o.find?.(0) ?? [] },
    seen: new Set(o.seen ?? [1, 2, 3]),
    signal: o.signal,
  })

describe('runAgent', () => {
  it('ends on the first turn with valid actions, with a frozen cached prefix', async () => {
    const { c, requests } = client([log(), del(2)])
    const result = await run(c)
    expect(result.turns).toBe(1)
    expect(result.actions.map((a) => a.tool)).toEqual(['log_movements', 'delete_movement'])
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    })
    const [req] = requests
    expect(req?.model).toBe('claude-haiku-5-5')
    expect(req?.thinking).toEqual({ type: 'disabled' })
    expect(req?.output_config).toEqual({ effort: 'low' })
    expect(req?.tools).toEqual(TOOLS)
    expect(req?.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ])
    expect(req?.messages).toEqual([{ role: 'user', content: 'ctx' }])
    expect(result.audit.map((e) => [e.tool, e.status, e.action])).toEqual([
      ['log_movements', 'accepted', 0],
      ['delete_movement', 'accepted', 1],
    ])
  })

  it('runs a read, answers it, then acts on an id the read returned', async () => {
    const { c, requests } = client(
      [find({ text: 'alquiler' })],
      [correct(77, { amount: '250000' })],
    )
    const result = await run(c, { find: () => [row(77)] })
    expect(result.turns).toBe(2)
    expect(result.actions).toEqual([
      { tool: 'correct_movement', input: { id: 77, changes: { amount: '250000' } } },
    ])
    const second = requests[1]?.messages
    expect(second?.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const results = second?.[2]?.content as Anthropic.ToolResultBlockParam[]
    expect(results).toHaveLength(1)
    expect(results[0]?.tool_use_id).toBe('t1_0')
    expect(results[0]?.content).toContain('id=77 out 1000 ARS 2026-11-01 09:00 alquiler [vivienda]')
    expect(result.audit.map((e) => e.status)).toEqual(['ok', 'accepted'])
  })

  it('answers parallel tool calls in one user message, each with its own id', async () => {
    const { c, requests } = client([find({ text: 'a' }), find({ text: 'b' })], [del(5)])
    await run(c, { find: () => [row(5)] })
    const results = requests[1]?.messages[2]?.content as Anthropic.ToolResultBlockParam[]
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1_0', 't1_1'])
  })

  it('refuses an id it was never shown, tells the model, and lets it try again', async () => {
    const { c, requests } = client([del(999)], [del(2)])
    const result = await run(c)
    expect(result.turns).toBe(2)
    expect(result.actions).toEqual([{ tool: 'delete_movement', input: { id: 2 } }])
    const [refusal] = (requests[1]?.messages[2]?.content ?? []) as Anthropic.ToolResultBlockParam[]
    expect(refusal?.is_error).toBe(true)
    expect(String(refusal?.content)).toContain('999 was not shown')
    expect(result.audit[0]).toMatchObject({ tool: 'delete_movement', status: 'rejected' })
  })

  it('refuses values the table cannot hold: a thousands separator, a future date, an empty change', async () => {
    for (const bad of [
      log(movement({ amount: '3.500' })),
      log(movement({ date: '2026-11-22' })),
      correct(1, { amount: '3,5' }),
      correct(1, {}),
      { name: 'ask_user', input: { question: 'x', movement_ids: [1], after_answer: 'correct' } },
    ]) {
      const { c } = client([bad], [del(1)])
      const result = await run(c)
      expect(result.turns, JSON.stringify(bad)).toBe(2)
      expect(result.audit[0]?.status).toBe('rejected')
    }
  })

  it('does not run the valid calls of a turn when another call of it was refused', async () => {
    const { c, requests } = client([log(), del(999)], [log(), del(2)])
    const result = await run(c)
    expect(result.audit.map((e) => e.status)).toEqual([
      'skipped',
      'rejected',
      'accepted',
      'accepted',
    ])
    expect(result.actions.map((a) => a.tool)).toEqual(['log_movements', 'delete_movement'])
    const results = requests[1]?.messages[2]?.content as Anthropic.ToolResultBlockParam[]
    expect(results.every((r) => r.is_error)).toBe(true)
  })

  it('caps the movements of a message at 10 across its log calls', async () => {
    const eleven = Array.from({ length: 6 }, () => movement())
    const { c } = client([log(...eleven), log(...eleven)], [log(...eleven)])
    const result = await run(c)
    expect(result.turns).toBe(2)
    expect(result.audit.map((e) => e.status)).toEqual(['skipped', 'rejected', 'accepted'])
  })

  it('fails after the turn cap, having written nothing', async () => {
    const { c, requests } = client([del(999)], [del(999)], [del(999)], [del(2)])
    await expect(run(c)).rejects.toThrow(AgentError)
    expect(requests).toHaveLength(MAX_TURNS)
    expect(MAX_TURNS).toBe(3)
  })

  it('a read that never leads to an action also ends at the cap', async () => {
    const { c, requests } = client([find()], [find()], [find()])
    await expect(run(c)).rejects.toThrow(/no valid action after 3/)
    expect(requests).toHaveLength(3)
  })

  it('asks again when the model writes text instead of calling a tool, once per turn', async () => {
    const { c, requests } = client('¿Qué querés decir con 2?', [del(2)])
    const result = await run(c)
    expect(result.actions).toEqual([{ tool: 'delete_movement', input: { id: 2 } }])
    expect(String(requests[1]?.messages[2]?.content)).toContain('You did not call a tool')
    expect(result.audit[0]).toMatchObject({ tool: 'text', status: 'rejected' })
  })

  it('gives the deadline signal to every model call', async () => {
    const abort = new AbortController()
    const { c, signals } = client([find()], [del(1)])
    await run(c, { signal: abort.signal })
    expect(signals).toEqual([abort.signal, abort.signal])
  })

  it('an abort ends the loop with the error of the call', async () => {
    const c = {
      messages: {
        create: async (_p: unknown, o?: { signal?: AbortSignal }) => {
          throw o?.signal?.reason ?? new Error('no signal')
        },
      },
    } as unknown as Anthropic
    const abort = new AbortController()
    abort.abort(new Error('deadline'))
    await expect(run(c, { signal: abort.signal })).rejects.toThrow('deadline')
  })

  it('replaces a question that carries a digit or a money sign, so the model cannot write a figure', async () => {
    const ask = (question: string): Call => ({
      name: 'ask_user',
      input: { question, movement_ids: [1, 2], after_answer: 'none' },
    })
    for (const [question, shown] of [
      ['Cuál de los 3 cafés', 'Cuál'],
      ['Era $3.500?', 'Cuál'],
      ['¿Cuál café?', 'Cuál café'],
      ['No encuentro un almuerzo. Cuál querés borrar', 'Cuál'],
      ['Cuál de todos los cafés querés que cambie ahora', 'Cuál'],
    ] as const) {
      const { c } = client([ask(question)])
      const result = await run(c)
      expect(result.actions[0]).toMatchObject({ tool: 'ask_user', input: { question: shown } })
    }
  })
})

describe('warmUp', () => {
  it('sends the same frozen prefix as a real request, with a tiny message', async () => {
    const { c, requests } = client([])
    await warmUp(c, 'haiku')
    const [req] = requests
    expect(req?.tools).toEqual(TOOLS)
    expect(req?.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ])
    expect(req?.max_tokens).toBe(16)
  })
})
