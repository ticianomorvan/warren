import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { TOOL_INPUTS, type ToolName } from './schema'

const DESCRIPTIONS: Record<ToolName, string> = {
  find_movements:
    "Search the person's whole history for a movement that is not in the list of the 10 newest. Returns up to 20 live movements with their ids, newest first. Leave out the filters you do not need.",
  log_movements: 'Record 1 to 10 new movements (expenses or income) the person tells you about.',
  correct_movement:
    'Change fields of one existing movement, by id. Only the fields that change are sent.',
  delete_movement: 'Delete one existing movement, by id.',
  summarize:
    'Answer how much the person spent or received in a period, or how many movements there were. Code computes the totals and the counts; you only choose the period and the filters (including the words of a description, for "cuántos cafés").',
  ask_user:
    'Ask the person a question when you cannot act. Code writes the question and lists the movements you give.',
  reply:
    'Answer in words, for anything that is not a change to the ledger: a question about what you did or what is stored, small talk, something you cannot do, a request outside expenses, a change when the person has no movements at all (never when some exist and none fits: that is ask_user). Short, in Argentine Spanish. The text may use only numbers that code gave you.',
  help: 'Send the canned help text: only when the person asks for help or what you can do, or greets you.',
  undo_last:
    'Undo the person\'s LAST batch of changes as a whole (everything one earlier message logged, corrected or deleted): "deshacer", "volvé atrás", "anulá lo que hiciste", "no, eso no" right after a record. Code finds the batch and writes what it undid; you send no id. Never for one named movement (that is delete_movement or correct_movement), and never together with another action.',
}

/** The strict-tool form of a zod schema: the API rejects numeric bounds and the `$schema` key. */
function inputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<string, unknown>
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => key !== 'minimum' && key !== 'maximum')
          .map(([key, value]) => [key, strip(value)]),
      )
    }
    return node
  }
  return strip(json) as Anthropic.Tool.InputSchema
}

/**
 * The tool list, built once and never changed: its order and bytes are part of the cached prefix
 * (tools come before the system prompt in the cache key).
 */
export const TOOLS: Anthropic.Tool[] = (Object.keys(TOOL_INPUTS) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  input_schema: inputSchema(TOOL_INPUTS[name]()),
  strict: true,
}))
