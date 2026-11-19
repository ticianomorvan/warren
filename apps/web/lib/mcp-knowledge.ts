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

const principleSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  applies_to: z.array(z.enum(TOPICS)),
})
const trapSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  signs: z.array(z.string()),
  what_to_do: z.string(),
})
const factSchema = z.looseObject({
  id: z.string(),
  topic: z.enum(TOPICS),
  statement: z.string(),
  value: z.string().optional().describe('Decimal string, present when the fact is one number.'),
  unit: z.string().optional(),
  display: z
    .string()
    .optional()
    .describe('`value` and `unit` as shown to the person, e.g. "$ 50.000.000,00 per person".'),
  parts: z
    .array(
      z.looseObject({
        label: z.string(),
        value: z.string().describe('Decimal string, in `unit`.'),
        unit: z.string(),
        display: z.string().describe('`value` and `unit` as shown to the person.'),
      }),
    )
    .optional()
    .describe('Further named amounts, e.g. one per monotributo category.'),
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
const _factKeys: Same<keyof typeof factSchema.shape, keyof FactView> = true
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
        'a person can check: calls or messages asking for a card code or password, promised ' +
        'returns, requests for money up front. The content is general and does not depend on ' +
        'the user.',
      inputSchema: z.object({ topic }),
      outputSchema: z.looseObject({
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
        'given. Each has its statement, value and unit, a `display` text of the value, ' +
        '`parts` when it holds several named amounts, the date it was read (`as_of`), the ' +
        'date to check it again by (`review_by`), `stale` (true when the Argentine calendar ' +
        'date, America/Argentina/Buenos_Aires, is past `review_by`), whether it is a `slow` regulatory figure or a `moving` market value, ' +
        'and its source name and link.',
      inputSchema: z.object({ topic }),
      outputSchema: z.looseObject({
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
