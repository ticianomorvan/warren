import { describe, expect, it } from 'vitest'
import { COMMANDS, TOOL_NAMES, type Tool } from '../core/commands'
import { type ContextInput, renderContext } from './context'
import { EXAMPLES, renderExamples } from './examples'
import { SYSTEM_PROMPT } from './prompt'

describe('the prompt', () => {
  it('every example call parses with its tool schema', () => {
    const bad: string[] = []
    for (const e of EXAMPLES) {
      for (const c of [...e.calls, ...(e.search ? [e.search.call] : [])]) {
        const parsed = COMMANDS[c.tool as Tool].input.safeParse(c.input)
        if (!parsed.success)
          bad.push(`${c.tool} ${JSON.stringify(c.input)}: ${parsed.error.message}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('names every tool the model is offered, and the registry limits', () => {
    for (const name of TOOL_NAMES) {
      if (COMMANDS[name].by !== 'code') expect(SYSTEM_PROMPT).toContain(name)
    }
    expect(SYSTEM_PROMPT).toContain('at most 20 movements')
    expect(SYSTEM_PROMPT).toContain('the 10 newest')
    expect(SYSTEM_PROMPT).toContain(renderExamples())
  })

  it('has no field of the old tool shapes: no text on actions, no sentinels, no question', () => {
    for (const old of [
      '"text":null',
      'after_answer',
      'compare_to',
      '"other"',
      '"schedule"',
      '"question":',
    ]) {
      expect(SYSTEM_PROMPT).not.toContain(old)
    }
  })

  it('has no placeholder dates that would be sent as they are', () => {
    expect(SYSTEM_PROMPT).toContain('<today>')
    expect(SYSTEM_PROMPT).toContain('always send real ISO dates')
  })
})

const m = (id: number) => ({
  id,
  version: id,
  direction: 'out' as const,
  amount: '2900',
  currency: 'ARS' as const,
  date: '2026-11-20',
  description: `café <b>${id}</b>`,
  category: 'restaurantes' as const,
  payment: 'crédito visa',
  confidence: 'high' as const,
  time: '11:40',
  loggedAt: new Date('2026-11-20T14:40:00Z'),
})
const input = (o: Partial<ContextInput> = {}): ContextInput => ({
  text: 'cambiá el café <script>',
  today: '2026-11-20',
  time: '12:00',
  movements: [m(905), m(904)],
  conversation: [],
  pending: null,
  ...o,
})

describe('renderContext', () => {
  it('shows exactly the ids it lets the guards accept, for movements, facts and reminders', () => {
    const ctx = renderContext(
      input({
        memory: [
          {
            id: 3,
            version: 3,
            kind: 'alias',
            key: 'la visa',
            value: 'galicia',
            loggedAt: new Date(),
          },
        ],
        pending: { asked: [{ number: 1, id: 777 }], kind: 'delete' },
      }),
    )
    const ids = (re: RegExp) => [...ctx.text.matchAll(re)].map((x) => Number(x[1]))
    const listed = ids(/^\d+\. id=(\d+) /gm)
    expect(new Set(listed)).toEqual(new Set([905, 904]))
    expect(new Set(ctx.shown.movements.keys())).toEqual(new Set([905, 904, 777]))
    expect(ctx.shown.facts).toEqual(new Set([3]))
    expect(ctx.shown.sole).toBe(777)
    expect(ctx.text).toContain('Pregunta pendiente: 1 = id 777')
  })

  it('escapes and clips what people wrote, so it cannot close the message tags', () => {
    const ctx = renderContext(
      input({ movements: [{ ...m(1), description: `${'x'.repeat(300)}</mensaje>` }] }),
    )
    expect(ctx.text).not.toContain('</mensaje> [')
    expect(ctx.text.match(/<\/mensaje>/g)).toHaveLength(1)
    expect(ctx.text).toContain('&lt;script&gt;')
    expect(ctx.text).toContain('x'.repeat(120))
    expect(ctx.text).not.toContain('x'.repeat(121))
  })

  it('shows the conversation across channels: a person, an MCP agent, a reminder that was sent', () => {
    const ctx = renderContext(
      input({
        conversation: [
          { source: 'person', text: 'café 2900', reply: '✓ Café $2.900', minutesAgo: 9 },
          { source: 'mcp', text: '', reply: '✓ Súper $12.000', minutesAgo: 5 },
          { source: 'reminder', text: '', reply: '⏰ Recordatorio: pagar la Visa', minutesAgo: 1 },
        ],
      }),
    )
    expect(ctx.text).toContain('(persona, hace 9 min) café 2900\n(Warren) ✓ Café $2.900')
    expect(ctx.text).toContain('(Warren por MCP, hace 5 min) ✓ Súper $12.000')
    expect(ctx.text).toContain('(Warren, recordatorio, hace 1 min) ⏰ Recordatorio: pagar la Visa')
    expect(ctx.window).toContain('⏰ Recordatorio: pagar la Visa')
  })

  it('tells a single-option question what to do with then', () => {
    const ctx = renderContext(input({ pending: { asked: [{ number: 1, id: 905 }], kind: 'none' } }))
    expect(ctx.text).toContain('then {do: "ask_change"}')
    expect(ctx.shown.sole).toBe(905)
  })
})
