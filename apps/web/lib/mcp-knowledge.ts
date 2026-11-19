import type { McpServer } from '@modelcontextprotocol/server'
import {
  type FactView,
  factsFor,
  PROFESSIONALS,
  type Principle,
  principlesFor,
  TOPICS,
  TRAPS,
  type Trap,
} from '@warren/core'
import { z } from 'zod'

const topic = z.enum(TOPICS).optional().describe('Only this topic; leave out for all.')

const principleSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  applies_to: z.array(z.enum(TOPICS)),
})
const trapSchema = z.object({
  id: z.string(),
  title: z.string(),
  signs: z.array(z.string()),
  what_to_do: z.string(),
})
const factSchema = z.object({
  id: z.string(),
  topic: z.enum(TOPICS),
  statement: z.string(),
  value: z.string().optional().describe('Decimal string, present when the fact is one number.'),
  unit: z.string().optional(),
  as_of: z.string().describe('yyyy-mm-dd, the day the value was read from its source.'),
  review_by: z.string().describe('yyyy-mm-dd, the day after which it must be checked again.'),
  stale: z.boolean().describe('True when today (in Argentina) is past `review_by`.'),
  volatility: z.enum(['slow', 'moving']),
  source_url: z.string(),
  source_name: z.string(),
  needs_professional: z.enum(PROFESSIONALS).optional(),
})

// What the tools return is the core types, not a copy of them: if either side changes, the
// build fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _principle: Same<z.infer<typeof principleSchema>, Principle> = true
const _trap: Same<z.infer<typeof trapSchema>, Trap> = true
// Optional fields differ only in `| undefined`, so a fact is checked by its keys and one way.
const _factKeys: Same<keyof z.infer<typeof factSchema>, keyof FactView> = true
const _fact: FactView extends z.infer<typeof factSchema> ? true : never = true
void [_principle, _trap, _factKeys, _fact]

const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true }

const answer = <T extends Record<string, unknown>>(output: T) => ({
  structuredContent: output,
  content: [{ type: 'text' as const, text: JSON.stringify(output) }],
})

/**
 * `knowledge_list_principles` and `knowledge_list_facts`: Warren's curated, dated knowledge.
 * Nothing here is about the user, so the tools read no database.
 */
export function registerKnowledgeTools(server: McpServer, { now }: { now: () => Date }) {
  server.registerTool(
    'knowledge_list_principles',
    {
      title: 'List financial principles and traps',
      description:
        "Returns Warren's general personal-finance principles for Argentina (each with a " +
        'title, a body and the topics it applies to), filtered by `topic` when given, and ' +
        'always the known scam and bad-advice patterns (traps), each with its signs and what ' +
        'a person can check. The content is general and does not depend on the user.',
      inputSchema: z.object({ topic }),
      outputSchema: z.object({
        principles: z.array(principleSchema),
        traps: z.array(trapSchema),
      }),
      annotations,
    },
    async ({ topic }) => answer({ principles: principlesFor(topic), traps: TRAPS }),
  )

  server.registerTool(
    'knowledge_list_facts',
    {
      title: 'List dated Argentine facts',
      description:
        'Returns dated facts about Argentina (exchange rates, deposit rates, inflation, ' +
        'monotributo, deposit guarantee, tax and pension figures), filtered by `topic` when ' +
        'given. Each has its statement, value and unit, the date it was read (`as_of`), the ' +
        'date to check it again by (`review_by`), `stale` (true when the Argentine calendar ' +
        'date, America/Argentina/Buenos_Aires, is past `review_by`), whether it is a `slow` regulatory figure or a `moving` market value, ' +
        'and its source name and link.',
      inputSchema: z.object({ topic }),
      outputSchema: z.object({
        facts: z.array(factSchema),
        checked_at: z.string().describe('ISO timestamp that `stale` was computed against.'),
      }),
      annotations,
    },
    async ({ topic }) => {
      const at = now()
      return answer({ facts: factsFor(at, topic), checked_at: at.toISOString() })
    },
  )
}
