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
  input: { movements: m.length ? m : [movement()], text: null },
})
const correct = (id: number, changes: object): Call => ({
  name: 'correct_movement',
  input: { id, changes, text: null },
})
const del = (id: number): Call => ({ name: 'delete_movement', input: { id, text: null } })
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

const inputFor = (c: Anthropic) => ({
  client: c,
  model: 'haiku' as const,
  context: 'ctx',
  facts: [] as string[],
  window: [] as string[],
  message: '',
  today: '2026-11-21',
  env: { find: async () => [] as MovementRow[] },
  seen: new Set([1, 2, 3]),
})

const run = (
  c: Anthropic,
  o: {
    seen?: number[]
    find?: (id: number) => MovementRow[]
    signal?: AbortSignal
    facts?: string[]
    window?: string[]
    message?: string
  } = {},
) =>
  runAgent({
    client: c,
    model: 'haiku',
    context: 'ctx',
    facts: o.facts ?? [],
    window: o.window ?? [],
    message: o.message ?? '',
    today: '2026-11-21',
    env: { find: async () => o.find?.(0) ?? [] },
    seen: new Set(o.seen ?? [1, 2, 3]),
    signal: o.signal,
  })

describe('runAgent', () => {
  it('refuses a write to an id that first appears in a find_movements of the same turn', async () => {
    // The model cannot have seen those results yet: an id there was guessed, not chosen.
    const { c, requests } = client(
      [find({ text: 'alquiler' }), correct(777, { amount: '1' })],
      [correct(777, { amount: '250000' })],
    )
    const result = await run(c, { seen: [1, 2, 3], find: () => [row(777)] })
    expect(requests).toHaveLength(2)
    expect(result.actions).toEqual([
      { tool: 'correct_movement', input: { id: 777, changes: { amount: '250000' }, text: null } },
    ])
  })

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
      { tool: 'correct_movement', input: { id: 77, changes: { amount: '250000' }, text: null } },
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
    expect(result.actions).toEqual([{ tool: 'delete_movement', input: { id: 2, text: null } }])
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
      {
        name: 'ask_user',
        input: { question: 'x', movement_ids: [1], after_answer: 'correct', text: null },
      },
    ]) {
      const { c } = client([bad], [del(1)])
      // a message with an amount: a "correct" with no change left the amount out
      const result = await run(c, { message: 'cambiame el café a 5000' })
      expect(result.turns, JSON.stringify(bad)).toBe(2)
      expect(result.audit[0]?.status).toBe('rejected')
    }
  })

  it('takes an ask_user "correct" with no change as the question what to change when the message has no amount (live #70, #76)', async () => {
    for (const message of [
      'cambiemos el gasto de cafe',
      'Cambiamos el valor de uno de los YPFs.',
    ]) {
      for (const changes of [undefined, {}]) {
        const { c } = client([
          {
            name: 'ask_user',
            input: {
              question: 'x',
              movement_ids: [1, 2],
              after_answer: 'correct',
              ...(changes ? { changes } : {}),
            },
          },
        ])
        const result = await run(c, { message })
        expect(result.turns, message).toBe(1)
        expect(result.actions[0]).toMatchObject({
          tool: 'ask_user',
          input: { movement_ids: [1, 2], after_answer: 'none', changes: undefined },
        })
      }
    }
    // with an amount (in digits or words) the model left the change out: refused, and the reason says what to send
    for (const message of [
      'cambiame el almuerzo a 5000',
      'ponele tres mil al café',
      'pasalo a 5 lucas',
    ]) {
      const { c, requests } = client(
        [
          {
            name: 'ask_user',
            input: { question: 'x', movement_ids: [1], after_answer: 'correct' },
          },
        ],
        [del(1)],
      )
      const result = await run(c, { message })
      expect(result.turns, message).toBe(2)
      const [refusal] = (requests[1]?.messages[2]?.content ??
        []) as Anthropic.ToolResultBlockParam[]
      expect(String(refusal?.content)).toContain('send the new value the person gave in changes')
    }
  })

  it('takes a change given about the only option of a pending question as the correction, with no second turn (live #78)', async () => {
    const ask = {
      name: 'ask_user',
      input: {
        question: 'Cuál',
        movement_ids: [2],
        after_answer: 'correct',
        changes: { amount: '3500' },
      },
    }
    const { c } = client([ask])
    const result = await runAgent({ ...inputFor(c), sole: 2, message: 'a ese ponele 3500' })
    expect(result.turns).toBe(1)
    expect(result.actions).toEqual([
      { tool: 'correct_movement', input: { id: 2, changes: { amount: '3500' }, text: null } },
    ])
    // not for another movement, or when the question had no single option: it stays a question
    for (const sole of [3, undefined]) {
      const { c: c2 } = client([ask])
      const r = await runAgent({ ...inputFor(c2), sole, message: 'a ese ponele 3500' })
      expect(r.actions[0]?.tool, String(sole)).toBe('ask_user')
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
    expect(result.actions).toEqual([{ tool: 'delete_movement', input: { id: 2, text: null } }])
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
      input: { question, movement_ids: [1, 2], after_answer: 'none', text: null },
    })
    for (const [question, shown] of [
      ['Cuál de los 3 cafés', 'Cuál'],
      ['Era de doce mil', 'Cuál'],
      ['Cuál de los dos', 'Cuál'],
      ['Cuál ２５', 'Cuál'],
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

describe('runAgent: a turn that searches and changes in one', () => {
  it('runs the search, holds the changes and asks for every change again with the results', async () => {
    // "borra el súper y la nafta fue 4000": the model searches for the súper and, in the same
    // turn, corrects the nafta. The correction was written without the results: it is not run.
    const { c, requests } = client(
      [find({ text: 'súper' }), correct(2, { amount: '4000' })],
      [del(77), correct(2, { amount: '4000' })],
    )
    const result = await run(c, {
      seen: [1, 2, 3],
      find: () => [row(77, { description: 'súper' })],
    })

    expect(result.turns).toBe(2)
    expect(result.actions.map((a) => [a.tool, (a.input as { id: number }).id])).toEqual([
      ['delete_movement', 77],
      ['correct_movement', 2],
    ])
    expect(result.audit.map((e) => [e.tool, e.status])).toEqual([
      ['find_movements', 'ok'],
      ['correct_movement', 'held'],
      ['delete_movement', 'accepted'],
      ['correct_movement', 'accepted'],
    ])
    // The second request answers both calls of the first turn: the search with its rows, the change with the note.
    const [searched, held] = (requests[1]?.messages[2]?.content ??
      []) as Anthropic.ToolResultBlockParam[]
    expect(String(searched?.content)).toContain('id=77')
    expect(searched?.is_error).toBe(false)
    expect(String(held?.content)).toContain('Your changes were not run; send every change again')
    expect(held?.is_error).toBe(true)
  })

  it('holds every kind of write, not just corrections', async () => {
    for (const write of [
      log(),
      del(1),
      { name: 'reply', input: { text: 'Hola' } },
      { name: 'help', input: {} },
    ]) {
      const { c } = client([find(), write], [del(1)])
      const result = await run(c, { find: () => [row(77)] })
      expect(
        result.audit.map((e) => e.status),
        write.name,
      ).toEqual(['ok', 'held', 'accepted'])
      expect(result.actions.map((a) => a.tool)).toEqual(['delete_movement'])
    }
  })

  it('does not hold anything when there is no search: a log or a summary is one model call', async () => {
    const { c, requests } = client([log()])
    const result = await run(c)
    expect(requests).toHaveLength(1)
    expect(result.turns).toBe(1)
    expect(result.audit.map((e) => e.status)).toEqual(['accepted'])
  })

  it('counts the second turn inside the cap of 3: three mixed turns in a row fail with nothing run', async () => {
    const mixed = [find(), del(1)]
    const { c, requests } = client(mixed, mixed, mixed)
    await expect(run(c, { find: () => [row(77)] })).rejects.toThrow(/no valid action after 3/)
    expect(requests).toHaveLength(MAX_TURNS)
  })

  it('a refused call in the same turn says so, not that the turn searched', async () => {
    const { c, requests } = client([find(), del(999), log()], [log()])
    await run(c, { find: () => [row(77)] })
    const results = requests[1]?.messages[2]?.content as Anthropic.ToolResultBlockParam[]
    expect(results.map((r) => r.is_error)).toEqual([false, true, true])
    expect(String(results[2]?.content)).toContain('another call of this turn was refused')
  })

  it('returns what the searches found, once each, for the numbers check', async () => {
    const { c } = client([find({ text: 'a' }), find({ text: 'b' })], [del(77)])
    const result = await run(c, { find: () => [row(77), row(78)] })
    expect(result.found.map((r) => r.id)).toEqual([77, 78])
  })
})

describe('runAgent: a text that would be dropped is sent back', () => {
  const saying = (call: Call, text: string | null): Call => ({
    ...call,
    input: { ...(call.input as object), text },
  })
  const reasonSeen = (requests: Anthropic.MessageCreateParamsNonStreaming[], k: number) =>
    JSON.stringify(requests[k]?.messages.at(-1)?.content)

  it('gives the model another turn with the reason, and runs the repaired actions', async () => {
    const { c, requests } = client(
      [saying(del(2), 'Tenés cuatro cafés anotados.')],
      [saying(del(2), 'Borré el café.')],
    )
    const result = await run(c, { facts: ['cuantos cafes tengo'], message: 'borra el cafe' })
    expect(result.turns).toBe(2)
    expect(result.audit.map((e) => [e.status, e.detail ?? null])).toEqual([
      ['repair', expect.stringContaining('cuatro')],
      ['accepted', null],
    ])
    const told = reasonSeen(requests, 1)
    expect(told).toContain('would not be sent')
    expect(told).toContain('cuatro')
    expect(told).toContain('summarize')
    expect(result.actions).toMatchObject([{ input: { text: 'Borré el café.' } }])
  })

  it('sends back every action of the turn, not just the one with the bad text', async () => {
    const { c, requests } = client([saying(del(2), 'Son $9.999.'), log()], [del(2), log()])
    const result = await run(c, { facts: ['x'], message: 'x' })
    expect(result.audit.map((e) => e.status)).toEqual(['repair', 'repair', 'accepted', 'accepted'])
    const results = requests[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[]
    expect(results.every((r) => r.is_error)).toBe(true)
    expect(String(results[1]?.content)).toContain('another call of this turn')
  })

  it('lets a text through on the last turn: the commit point drops it, the message does not fail', async () => {
    const bad = saying(del(2), 'Son $9.999.')
    const { c, requests } = client([bad], [bad], [bad])
    const result = await run(c, { facts: ['x'], message: 'x' })
    expect(requests).toHaveLength(3)
    expect(result.actions).toHaveLength(1)
    expect(result.audit.map((e) => e.status)).toEqual(['repair', 'repair', 'accepted'])
  })

  it('does not send back an echo of the person, nor numbers the actions themselves carry', async () => {
    const { c, requests } = client([saying(del(2), 'borra el super de ayer')])
    await run(c, { message: 'borra el super de ayer' })
    expect(requests).toHaveLength(1)
    const m = movement({ amount: '25000' })
    const { c: c2, requests: r2 } = client([
      {
        name: 'log_movements',
        input: { movements: [m], text: 'Anoté $25.000 de hoy 2026-11-21.' },
      },
    ])
    await run(c2, { facts: ['cafe 25 lucas'], message: 'cafe 25 lucas' })
    expect(r2).toHaveLength(1)
  })

  it('judges a claim by the actions of the turn: a text that says it deleted, beside a log, is sent back', async () => {
    const { c, requests } = client([saying(log(), 'Ya borré la nafta.')], [log()])
    await run(c, { facts: ['x'], message: 'x' })
    expect(requests).toHaveLength(2)
    expect(reasonSeen(requests, 1)).toContain('claims a deletion')
  })

  it('lets only a reply lean on what Warren answered before', async () => {
    const reply = (text: string): Call => ({ name: 'reply', input: { text } })
    const { c, requests } = client([reply('Sí, lo borré.')])
    await run(c, { window: ['✓ Borré: Súper $12.000'], message: 'borraste el super?' })
    expect(requests).toHaveLength(1)
    const { c: c2, requests: r2 } = client([reply('Sí, lo borré.')], [reply('No sé.')])
    await run(c2, { message: 'borraste el super?' })
    expect(r2).toHaveLength(2)
  })
})

describe('runAgent: summarize filters are copied into a line', () => {
  it('refuses a description or a payment with a figure in it', async () => {
    const summarize = (o: object): Call => ({
      name: 'summarize',
      input: {
        range: { period: 'today', month: 0, year: 0, from: '', to: '' },
        group_by: 'none',
        compare_to: 'none',
        other: '',
        direction: 'out',
        category: null,
        payment: null,
        description: null,
        text: null,
        ...o,
      },
    })
    for (const bad of [{ description: 'café 12000' }, { payment: 'visa 4509' }]) {
      const { c } = client([summarize(bad)], [summarize({ description: 'café' })])
      const result = await run(c)
      expect(result.turns, JSON.stringify(bad)).toBe(2)
      expect(result.audit[0]).toMatchObject({ status: 'rejected' })
    }
  })
})

describe('runAgent: the last turn', () => {
  it('tells the model before its last turn that it is the last, so it does not search again', async () => {
    const { c, requests } = client([find()], [find(), del(1)], [del(1)])
    const result = await run(c, { find: () => [row(77)] })
    expect(result.turns).toBe(3)
    const second = requests[1]?.messages.at(-1)?.content as Anthropic.ContentBlockParam[]
    expect(JSON.stringify(second)).not.toContain('next turn is the last')
    const third = requests[2]?.messages.at(-1)?.content as Anthropic.ContentBlockParam[]
    expect(third.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringContaining('next turn is the last'),
    })
  })
})

describe('runAgent: a photo', () => {
  it('sends the image block before the context, in the first user message only', async () => {
    const { c, requests } = client([find()], [log()])
    await runAgent({
      client: c,
      model: 'haiku',
      context: 'ctx',
      photo: { mediaType: 'image/png', data: 'AAAA' },
      facts: [],
      window: [],
      message: '',
      today: '2026-11-21',
      env: { find: async () => [] },
      seen: new Set(),
    })
    expect(requests[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'ctx' },
        ],
      },
    ])
    // the later turns carry it on, as the first message of the same conversation
    expect(requests[1]?.messages[0]).toEqual(requests[0]?.messages[0])
  })

  it('sends plain text when there is no photo', async () => {
    const { c, requests } = client([log()])
    await run(c)
    expect(requests[0]?.messages[0]?.content).toBe('ctx')
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
