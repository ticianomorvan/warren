import { describe, expect, it } from 'vitest'
import { CATEGORIES, PERIODS, TOOL_INPUTS } from './schema'
import { TOOLS } from './tools'

type Json = { [key: string]: unknown }
const objects = (node: unknown): Json[] => {
  if (Array.isArray(node)) return node.flatMap(objects)
  if (node && typeof node === 'object') {
    const o = node as Json
    return [...(o.type === 'object' ? [o] : []), ...Object.values(o).flatMap(objects)]
  }
  return []
}

describe('TOOLS', () => {
  it('lists the tools in a fixed order: the cached prefix must not change between requests', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'find_movements',
      'log_movements',
      'correct_movement',
      'delete_movement',
      'summarize',
      'ask_user',
      'reply',
      'help',
      'undo_last',
    ])
    expect(Object.keys(TOOL_INPUTS)).toEqual(TOOLS.map((t) => t.name))
  })

  it('makes every tool strict, and every object closed with its required keys listed', () => {
    for (const tool of TOOLS) {
      expect(tool.strict, tool.name).toBe(true)
      for (const o of objects(tool.input_schema)) {
        expect(o.additionalProperties, tool.name).toBe(false)
        const keys = Object.keys(o.properties as Json)
        const required = (o.required ?? []) as string[]
        expect(
          required.every((k) => keys.includes(k)),
          tool.name,
        ).toBe(true)
      }
    }
  })

  it('stays inside the strict-mode limits: 24 optional parameters, 16 with a union type', () => {
    let optional = 0
    let unions = 0
    const count = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(count)
      if (!node || typeof node !== 'object') return
      const o = node as Json
      if (o.type === 'object') {
        const required = new Set((o.required ?? []) as string[])
        optional += Object.keys(o.properties as Json).filter((k) => !required.has(k)).length
      }
      if (Array.isArray(o.type) || 'anyOf' in o) unions++
      Object.values(o).forEach(count)
    }
    for (const tool of TOOLS) count(tool.input_schema)
    expect(optional).toBeLessThanOrEqual(24)
    expect(unions).toBeLessThanOrEqual(16)
  })

  it('has no bounds, $schema or $ref, which the API rejects', () => {
    const json = JSON.stringify(TOOLS.map((t) => t.input_schema))
    for (const banned of ['"minimum"', '"maximum"', '$schema', '$ref', '$defs']) {
      expect(json).not.toContain(banned)
    }
  })

  it('offers the categories and periods the rest of the code knows', () => {
    const json = JSON.stringify(TOOLS)
    for (const c of CATEGORIES) expect(json).toContain(c)
    for (const p of PERIODS) expect(json).toContain(p)
  })
})

describe('TOOL_INPUTS', () => {
  const movement = {
    direction: 'out',
    amount: '3500',
    currency: 'ARS',
    date: '2026-11-20',
    description: 'café',
    category: 'restaurantes',
    payment: null,
    confidence: 'high',
  }

  it('accepts a call of each tool, with unset optional fields left out', () => {
    expect(
      TOOL_INPUTS.log_movements().safeParse({ movements: [movement], text: null }).success,
    ).toBe(true)
    expect(
      TOOL_INPUTS.correct_movement().safeParse({
        id: 4,
        changes: { amount: '3800' },
        text: 'No encontré el súper.',
      }).success,
    ).toBe(true)
    expect(TOOL_INPUTS.find_movements().safeParse({ text: 'alquiler' }).success).toBe(true)
    expect(TOOL_INPUTS.delete_movement().safeParse({ id: 4, text: null }).success).toBe(true)
    expect(
      TOOL_INPUTS.summarize().safeParse({
        period: 'this_month',
        direction: 'out',
        category: null,
        payment: null,
        description: 'café',
        text: null,
      }).success,
    ).toBe(true)
    expect(
      TOOL_INPUTS.ask_user().safeParse({
        question: 'Cuál',
        movement_ids: [1, 2],
        after_answer: 'delete',
      }).success,
    ).toBe(true)
    expect(TOOL_INPUTS.reply().safeParse({ text: 'Sí, lo borré.' }).success).toBe(true)
    expect(TOOL_INPUTS.help().safeParse({}).success).toBe(true)
  })

  it('always carries the text key of the write tools (strict tools send every required key)', () => {
    expect(TOOL_INPUTS.delete_movement().safeParse({ id: 4 }).success).toBe(false)
    expect(TOOL_INPUTS.log_movements().safeParse({ movements: [movement] }).success).toBe(false)
  })

  it('has no text on ask_user: code asks the question once, so the model has nothing to add to it', () => {
    const parsed = TOOL_INPUTS.ask_user().parse({
      question: 'Cuál',
      movement_ids: [1, 2],
      after_answer: 'none',
      text: '¿Cuál café y qué cambio?',
    })
    expect(parsed).not.toHaveProperty('text')
    const ask = TOOLS.find((t) => t.name === 'ask_user')
    expect(JSON.stringify(ask?.input_schema)).not.toContain('"text"')
  })

  it('rejects unknown enums, non-integer ids and a period that does not exist', () => {
    expect(
      TOOL_INPUTS.log_movements().safeParse({ movements: [{ ...movement, category: 'comida' }] })
        .success,
    ).toBe(false)
    expect(
      TOOL_INPUTS.log_movements().safeParse({ movements: [{ ...movement, currency: 'EUR' }] })
        .success,
    ).toBe(false)
    expect(TOOL_INPUTS.delete_movement().safeParse({ id: 1.5, text: null }).success).toBe(false)
    expect(
      TOOL_INPUTS.summarize().safeParse({
        period: 'forever',
        direction: null,
        category: null,
        payment: null,
        description: null,
        text: null,
      }).success,
    ).toBe(false)
    expect(TOOL_INPUTS.reply().safeParse({ kind: 'joke' }).success).toBe(false)
  })
})
