/**
 * Counts the tokens of the frozen prefix (tools + system prompt) with the SDK's count-tokens call, which is free of charge.
 * `--before <file>` reads the old prefix from a JSON file {tools, system} (taken from the commit before the rebuild); with
 * `--warm` it also sends the `max_tokens: 0` pre-warm once, to check that the API accepts it.
 *   node --env-file=.env --import tsx evals/prompt-tokens.ts [--before file.json] [--warm]
 */
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { warmUp } from '../src/agent/loop'
import { SYSTEM_PROMPT } from '../src/agent/prompt'
import { TOOLS } from '../src/agent/tools'

const client = new Anthropic()
const count = async (tools: unknown[], system: string) =>
  (
    await client.messages.countTokens({
      model: 'claude-haiku-5-5',
      tools: tools as Anthropic.Tool[],
      system,
      messages: [{ role: 'user', content: 'x' }],
    })
  ).input_tokens

const args = process.argv.slice(2)
const out: Record<string, unknown> = {
  after: await count(TOOLS, SYSTEM_PROMPT),
  tools: TOOLS.length,
}
const beforeAt = args.indexOf('--before')
if (beforeAt >= 0) {
  const old = JSON.parse(readFileSync(args[beforeAt + 1] as string, 'utf8')) as {
    tools: unknown[]
    system: string
  }
  out.before = await count(old.tools, old.system)
}
if (args.includes('--warm')) {
  await warmUp(client)
  out.warm = 'accepted'
}
console.log(JSON.stringify(out))
