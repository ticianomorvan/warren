import { describe, expect, it } from 'vitest'
import { COMMANDS, labelOf, TOOL_NAMES, TOOLS, type Tool } from './commands'

describe('the registry', () => {
  it.each(TOOL_NAMES)('%s: every typed example parses with its own schema', (name) => {
    const entry = COMMANDS[name]
    expect(entry.examples.length).toBeGreaterThan(0)
    for (const example of entry.examples) {
      const parsed = entry.input.safeParse(example)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    }
  })

  it('offers the model every tool but the ones only code sends, in the registry order', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES.filter((n) => n !== 'forget_all_confirmed'))
  })

  it('has no `text` on an action tool: `reply` alone carries free text', () => {
    for (const tool of TOOLS) {
      const props = (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
      if (tool.name === 'find_movements') continue
      if (tool.name === 'reply') expect(Object.keys(props)).toEqual(['text'])
      else expect(Object.keys(props), tool.name).not.toContain('text')
    }
  })

  it('has no placeholder defaults in what the model sees', () => {
    expect(JSON.stringify(TOOLS)).not.toContain('"default"')
  })

  it('carries a description of every field of the tools with many (a client agent has no prompt)', () => {
    const json = JSON.stringify(TOOLS.find((t) => t.name === 'set_reminder'))
    expect(json).toContain('"first"')
    expect(json).toContain('minutes')
  })

  it('writes, answers, asks and reads are told apart, and only reads are not terminal', () => {
    const kinds = (kind: string) => TOOL_NAMES.filter((n) => COMMANDS[n].kind === kind)
    expect(kinds('read')).toEqual(['find_movements'])
    expect(kinds('ask').sort()).toEqual(['ask_user', 'forget_all_facts'])
    expect(kinds('write').sort()).toEqual(
      [
        'log_movements',
        'correct_movement',
        'delete_movement',
        'undo_last',
        'remember_fact',
        'forget_fact',
        'forget_all_confirmed',
        'set_reminder',
        'cancel_reminder',
      ].sort(),
    )
  })

  it('every write names its effect, and nothing else does', () => {
    for (const name of TOOL_NAMES) {
      const { kind, effect } = COMMANDS[name]
      expect(effect !== undefined, name).toBe(kind === 'write')
    }
  })

  it('an MCP block asks for the write scope exactly where the tool writes', () => {
    for (const name of TOOL_NAMES) {
      const { mcp, kind } = COMMANDS[name]
      if (!mcp) continue
      expect(mcp.scope, name).toBe(kind === 'write' ? 'ledger:write' : 'ledger:read')
    }
  })

  it('the tools that go alone are reply, undo and the forget-all question', () => {
    expect(TOOL_NAMES.filter((n) => COMMANDS[n].alone).sort()).toEqual([
      'forget_all_facts',
      'reply',
      'undo_last',
    ])
  })
})

describe('labels', () => {
  const calls = (...tools: Tool[]) => tools.map((tool) => ({ tool }))
  it('is the one tool’s label, or multi', () => {
    expect(labelOf(calls('log_movements'))).toBe('log')
    expect(labelOf(calls('forget_fact'))).toBe('forget')
    expect(labelOf(calls('forget_all_confirmed'))).toBe('forget')
    expect(labelOf(calls('cancel_reminder'))).toBe('remind')
    expect(labelOf(calls('list_facts'))).toBe('reply')
    expect(labelOf(calls('ask_user'))).toBe('ask')
    expect(labelOf(calls('log_movements', 'correct_movement'))).toBe('multi')
    expect(labelOf([])).toBe('multi')
  })
})
