import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, CommandSchema } from './schema'

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

describe('CommandSchema', () => {
  it('accepts every command type', () => {
    const changes = {
      direction: null,
      amount: '3800',
      currency: null,
      date: null,
      description: null,
      category: null,
      payment: null,
    }
    const commands = [
      { type: 'log', movements: [movement] },
      { type: 'correct', target: 'last', changes, confidence: 'high' },
      { type: 'delete', target: 'last', confidence: 'low' },
      { type: 'query', period: 'this_month', direction: 'out', category: null, payment: null },
      { type: 'help' },
      { type: 'off_topic' },
    ]
    for (const command of commands) expect(CommandSchema.safeParse(command).success).toBe(true)
  })

  it('rejects unknown enums and unknown command types', () => {
    const bad = [
      { type: 'log', movements: [{ ...movement, category: 'comida' }] },
      { type: 'log', movements: [{ ...movement, currency: 'EUR' }] },
      { type: 'log', movements: [{ ...movement, direction: 'sideways' }] },
      { type: 'log', movements: [{ ...movement, confidence: 'medium' }] },
      { type: 'query', period: 'forever', direction: null, category: null, payment: null },
      { type: 'refund' },
    ]
    for (const command of bad) expect(CommandSchema.safeParse(command).success).toBe(false)
  })

  it('keeps income categories in the fixed list', () => {
    expect(CATEGORIES).toContain('sueldo')
    expect(CATEGORIES).toContain('otros_ingresos')
  })

  it('generates a JSON schema without $defs, which the API rejects under a union', () => {
    const json = JSON.stringify(zodOutputFormat(CommandSchema).schema)
    expect(json).not.toContain('$defs')
    expect(json).not.toContain('$ref')
  })
})
