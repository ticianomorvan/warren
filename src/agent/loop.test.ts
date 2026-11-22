import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { message, toolUse } from '../../test/fakes'
import type { Shown } from '../core/guards'
import type { MovementRow } from '../domain/movements'
import { AgentError, CALL_TIMEOUT_MS, MAX_TURNS, runAgent, sumUsage, warmUp } from './loop'

const NOW = new Date('2026-11-20T15:00:00Z')
const row = (id: number): MovementRow => ({
  id,
  version: id,
  direction: 'out',
  amount: '2900',
  currency: 'ARS',
  date: '2026-11-20',
  description: 'café',
  category: 'restaurantes',
  payment: null,
  confidence: 'high',
  time: '11:40',
  loggedAt: NOW,
})
const shown = (...ids: number[]): Shown => ({
  movements: new Set(ids),
  facts: new Set(),
  reminders: new Set(),
})
const cafe = {
  direction: 'out',
  amount: '3500',
  currency: 'ARS',
  date: '2026-11-20',
  description: 'café',
  category: 'restaurantes',
  confidence: 'high',
}

type Reply = Anthropic.Message | Error
type Seen = {
  params: Anthropic.MessageCreateParamsNonStreaming
  options: Anthropic.RequestOptions | undefined
}

/** An Anthropic double that answers each call with the next reply, and keeps what it was sent. */
function fake(...replies: Reply[]) {
  const seen: Seen[] = []
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        options?: Anthropic.RequestOptions,
      ) => {
        seen.push({ params: structuredClone(params), options })
        const next = replies[seen.length - 1] ?? replies.at(-1)
        if (next instanceof Error) throw next
        return next as Anthropic.Message
      },
    },
  } as unknown as Anthropic
  return { client, seen }
}

const calls = (...c: [string, unknown][]) =>
  message(c.map(([name, input], k) => toolUse(`t${k}`, name, input)))

const run = (client: Anthropic, o: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({
    client,
    context: 'ctx',
    shown: shown(1),
    message: 'café 3500',
    today: '2026-11-20',
    now: NOW,
    env: { find: async () => [] },
    ...o,
  })

describe('runAgent', () => {
  it('ends on the first turn with valid calls', async () => {
    const { client, seen } = fake(calls(['log_movements', { movements: [cafe] }]))
    const r = await run(client)
    expect(r.calls).toEqual([{ tool: 'log_movements', input: { movements: [cafe] } }])
    expect(r.turns).toBe(1)
    expect(seen).toHaveLength(1)
    expect(r.audit.map((a) => [a.tool, a.status, a.action])).toEqual([
      ['log_movements', 'accepted', 0],
    ])
  })

  it('a refusal ends the message at once: one call, the category in the audit, nothing run, no retry', async () => {
    const refusal = message([toolUse('t0', 'log_movements', { movements: [] })], {
      stop_reason: 'refusal',
    })
    refusal.stop_details = { type: 'refusal', category: 'general_harms', explanation: null }
    const { client, seen } = fake(refusal, calls(['log_movements', { movements: [cafe] }]))
    const err = await run(client).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    const e = err as AgentError
    expect(e.refusal).toBe('general_harms')
    expect(e.audit).toEqual([
      { turn: 1, tool: 'refusal', input: null, status: 'refusal', detail: 'general_harms', ms: 0 },
    ])
    expect(e.turnLog).toHaveLength(1)
    expect(seen).toHaveLength(1)
  })

  it('a refusal without a category says unknown', async () => {
    const refusal = message([], { stop_reason: 'refusal' })
    const { client } = fake(refusal)
    const e = (await run(client).catch((x: unknown) => x)) as AgentError
    expect(e.refusal).toBe('unknown')
  })

  it('a cut-off answer is never read', async () => {
    const cut = message([toolUse('t0', 'log_movements', { movements: [cafe] })], {
      stop_reason: 'max_tokens',
    })
    const { client } = fake(cut)
    await expect(run(client)).rejects.toThrow('cut off')
  })

  it('gives up after MAX_TURNS turns with no valid call, having asked exactly that many times', async () => {
    const bad = calls(['delete_movement', { id: 99 }])
    const { client, seen } = fake(bad)
    const err = (await run(client).catch((e: unknown) => e)) as AgentError
    expect(err).toBeInstanceOf(AgentError)
    expect(err.message).toBe(`no valid action after ${MAX_TURNS} model turns`)
    expect(seen).toHaveLength(MAX_TURNS)
    expect(err.turns).toBe(MAX_TURNS)
    expect(err.turnLog).toHaveLength(MAX_TURNS)
    expect(err.audit.every((a) => a.status === 'rejected')).toBe(true)
    // The model is told it is the last turn on the one before it.
    const last = seen[MAX_TURNS - 1]?.params.messages.at(-1)
    expect(JSON.stringify(last)).toContain('last one')
  })

  it('text with no tool call is answered once with the list of tools, and never sent', async () => {
    const text = message([{ type: 'text', text: 'hola', citations: null }], {
      stop_reason: 'end_turn',
    })
    const { client, seen } = fake(text, calls(['help', {}]))
    const r = await run(client)
    expect(r.calls).toEqual([{ tool: 'help', input: {} }])
    expect(JSON.stringify(seen[1]?.params.messages.at(-1))).toContain('did not call a tool')
    expect(r.audit[0]).toMatchObject({ tool: 'text', status: 'rejected' })
  })

  it('every call gets a timeout and one retry, inside the message deadline', async () => {
    const { client, seen } = fake(calls(['help', {}]))
    await run(client, { deadlineAt: Date.now() + 3_000 })
    const options = seen[0]?.options
    expect(options?.maxRetries).toBe(1)
    expect(options?.timeout).toBeLessThanOrEqual(3_000)
    expect(options?.timeout).toBeGreaterThan(0)
    const plain = fake(calls(['help', {}]))
    await run(plain.client)
    expect(plain.seen[0]?.options?.timeout).toBe(CALL_TIMEOUT_MS)
  })

  it('does not call the model once the deadline has passed', async () => {
    const { client, seen } = fake(calls(['help', {}]))
    await expect(run(client, { deadlineAt: Date.now() - 1 })).rejects.toThrow('out of time')
    expect(seen).toHaveLength(0)
  })

  it('a call that times out fails the message with what it tried', async () => {
    const { client } = fake(new Error('Request timed out.'))
    await expect(run(client)).rejects.toThrow('timed out')
  })

  it('sums the usage from the turn log: reads and the action, cache writes of both TTLs', async () => {
    const search = message([toolUse('t0', 'find_movements', { text: 'cafe' })], {
      usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 1000 },
    })
    const act = message(
      [toolUse('t1', 'correct_movement', { id: 7, changes: { amount: '3800' } })],
      {
        usage: {
          input_tokens: 30,
          output_tokens: 11,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
        },
      },
    )
    const { client } = fake(search, act)
    const r = await run(client, { env: { find: async () => [row(7)] } })
    expect(r.turns).toBe(2)
    expect(r.usage).toEqual({
      inputTokens: 130,
      outputTokens: 18,
      cacheReadTokens: 3000,
      cacheWriteTokens: 500,
      cacheWrite1hTokens: 400,
    })
    expect(r.usage).toEqual(sumUsage(r.turnLog))
  })

  it('an id found by a search is shown from the next turn only, and the caller set is untouched', async () => {
    const start = shown(1)
    // The same turn guesses the id the search will find: refused. The next turn may use it.
    const guess = calls(['find_movements', { text: 'cafe' }], ['delete_movement', { id: 7 }])
    const next = calls(['delete_movement', { id: 7 }])
    const { client, seen } = fake(guess, next)
    const r = await run(client, { shown: start, env: { find: async () => [row(7)] } })
    expect(r.calls).toEqual([{ tool: 'delete_movement', input: { id: 7 } }])
    expect(r.found.map((m) => m.id)).toEqual([7])
    expect([...start.movements]).toEqual([1])
    const results = JSON.stringify(seen[1]?.params.messages.at(-1))
    expect(results).toContain('1 found')
    expect(results).toContain('was not shown to you')
  })

  it('a turn that searches and also changes runs no change (held), and one refused call skips the rest', async () => {
    const held = calls(['find_movements', { text: 'x' }], ['log_movements', { movements: [cafe] }])
    const fixed = calls(['log_movements', { movements: [cafe] }])
    const a = fake(held, fixed)
    const r = await run(a.client)
    expect(r.audit.map((x) => x.status)).toEqual(['ok', 'held', 'accepted'])
    expect(r.calls).toHaveLength(1)

    const skip = calls(['delete_movement', { id: 99 }], ['log_movements', { movements: [cafe] }])
    const b = fake(skip, fixed)
    const r2 = await run(b.client)
    expect(r2.audit.map((x) => x.status)).toEqual(['rejected', 'skipped', 'accepted'])
  })

  it('a decline is answered by code and is a valid end of the turn', async () => {
    const secret = calls([
      'remember_fact',
      { kind: 'note', key: 'clave', value: 'mi contraseña es 1234' },
    ])
    const { client, seen } = fake(secret)
    const r = await run(client, { message: 'mi contraseña es 1234' })
    expect(r.declined).toEqual(['secret'])
    expect(r.calls).toEqual([])
    expect(seen).toHaveLength(1)
  })

  it('reply goes alone', async () => {
    const both = calls(['reply', { text: 'hola' }], ['help', {}])
    const { client } = fake(both, calls(['reply', { text: 'hola' }]))
    const r = await run(client)
    expect(r.calls).toEqual([{ tool: 'reply', input: { text: 'hola' } }])
    expect(r.audit.map((x) => x.status)).toEqual(['rejected', 'skipped', 'accepted'])
  })
})

describe('warmUp', () => {
  it('sends the frozen prefix with max_tokens 0 and the 1h cache', async () => {
    const { client, seen } = fake(message([], { stop_reason: 'end_turn' }))
    await warmUp(client)
    const [{ params }] = seen as [Seen]
    expect(params.max_tokens).toBe(0)
    expect(params.model).toBe('claude-haiku-5-5')
    expect(JSON.stringify(params.system)).toContain('"ttl":"1h"')
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params.output_config).toEqual({ effort: 'low' })
    expect(params.tool_choice).toBeUndefined()
  })
})
