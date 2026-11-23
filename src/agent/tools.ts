import { z } from 'zod'
import { COMMANDS, type Entry, type Tool } from '../core/commands'

/**
 * The tools as the Anthropic API takes them: the registry (`core/commands.ts`, data only) shaped into JSON. This is the one place
 * that knows the API's tool format; the registry itself knows of no model.
 */

/** The Anthropic tool definition of a registry entry: the input's JSON schema (defaults are how code reads a field the model left out, not something to show it). */
function definition(name: Tool, entry: Entry) {
  const { $schema: _, ...schema } = z.toJSONSchema(entry.input, { io: 'input' }) as Record<
    string,
    unknown
  >
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node)
          // `z.int()` states the safe-integer range as its bounds: noise for the model, so only real bounds stay.
          .filter(
            ([key, value]) =>
              key !== 'default' &&
              !(
                (key === 'minimum' || key === 'maximum') &&
                Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER
              ),
          )
          .map(([key, value]) => [key, strip(value)]),
      )
    }
    return node
  }
  return {
    name,
    description: entry.description,
    input_schema: strip(schema) as { type: 'object'; [key: string]: unknown },
  }
}

/**
 * The tools the model is offered, in the registry's order, built once and never changed: its order and bytes are part of the cached
 * prefix. The tools are not `strict`; the input is parsed with the same zod schema and every value is checked by code.
 */
const entries = Object.entries(COMMANDS) as [Tool, Entry][]

export const TOOLS = entries
  .filter(([, entry]) => entry.by !== 'code')
  .map(([name, entry]) => definition(name, entry))
