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
    'Answer how much the person spent or received over any days (a named period, a month, a year or explicit days), optionally split by category, payment, day, week or month, or compared with the period before or a second range. Code resolves the days and computes every total, count, difference and percentage; you only choose the range, the split, the comparison and the filters (including the words of a description, for "cuántos cafés"). Its "text" is null: code writes the answer, and the question is never copied into it.',
  ask_user:
    'Ask the person a question when you cannot act. Code writes the question and lists the movements you give. With after_answer "correct", changes always holds the new value the person already gave (an amount, a date, a payment): never leave it out.',
  reply:
    'Answer in words, for anything that is not a change to the ledger: a question about what you did or what is stored, small talk, something you cannot do, a request outside expenses, a change when the person has no movements at all (never when some exist and none fits: that is ask_user). Short, in Argentine Spanish. The text may use only numbers that code gave you.',
  help: 'Send the canned help text: only when the person asks for help or what you can do, or greets you.',
  undo_last:
    'Undo the person\'s LAST batch of changes as a whole (everything one earlier message logged, corrected or deleted): "deshacer", "volvé atrás", "anulá lo que hiciste", "no, eso no" right after a record. Code finds the batch and writes what it undid; you send no id. Never for one named movement (that is delete_movement or correct_movement), and never together with another action.',
}

/** The JSON schema of a zod schema, without numeric bounds and the `$schema` key (the checks of a value are code's: `validate.ts`). */
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
 * (tools come before the system prompt in the cache key). The tools are not `strict`: strict decoding
 * made every call about 0.35 s slower (agent-spec, speed pass), and nothing relies on it. The model's
 * input is parsed with the same zod schema and every value is checked by code (`checkCall`); an input that
 * does not fit is refused with its reason and the model sends it again.
 */
export const TOOLS: Anthropic.Tool[] = (Object.keys(TOOL_INPUTS) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  input_schema: inputSchema(TOOL_INPUTS[name]()),
}))
