import { describe, expect, it } from 'vitest'
import { COMMANDS, type Tool } from './commands'

const TOOL_NAMES = Object.keys(COMMANDS) as Tool[]

describe('the registry', () => {
  it('is the ledger and nothing the old chat needed: no question, reply, skip, help or reminder', () => {
    expect(TOOL_NAMES.sort()).toEqual(
      [
        'find_movements',
        'log_movements',
        'correct_movement',
        'delete_movement',
        'summarize',
        'undo_last',
        'remember_fact',
        'forget_fact',
        'list_facts',
      ].sort(),
    )
  })

  it('reads and writes are told apart', () => {
    const kinds = (kind: string) => TOOL_NAMES.filter((n) => COMMANDS[n].kind === kind)
    expect(kinds('read').sort()).toEqual(['find_movements', 'list_facts', 'summarize'])
    expect(kinds('write').sort()).toEqual(
      [
        'log_movements',
        'correct_movement',
        'delete_movement',
        'undo_last',
        'remember_fact',
        'forget_fact',
      ].sort(),
    )
  })

  it('asks for the write scope exactly where the tool writes', () => {
    for (const name of TOOL_NAMES) {
      const { mcp, kind } = COMMANDS[name]
      expect(mcp.scope, name).toBe(kind === 'write' ? 'ledger:write' : 'ledger:read')
    }
  })

  it('names no chat app in what an agent is told: any MCP client reads it', () => {
    for (const name of TOOL_NAMES) {
      expect(`${COMMANDS[name].mcp.title} ${COMMANDS[name].mcp.description}`, name).not.toMatch(
        /whatsapp|deshacer|claude/i,
      )
    }
  })
})
