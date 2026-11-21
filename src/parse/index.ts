import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { MODELS, type ModelKey, type Usage } from './models'
import { renderVolatile, SYSTEM_PROMPT } from './prompt'
import { type Command, CommandSchema, type RecentMovement } from './schema'
import { type Issue, validateCommand } from './validate'

export type { ModelKey, Usage } from './models'
export { estimateCostUsd, MODELS } from './models'
export type { Command, Movement, RecentMovement } from './schema'
export { CATEGORIES, CommandSchema } from './schema'
export type { Issue } from './validate'

export type ParseResult = {
  /** The model's command, validated; a failed check lowers confidence and adds an issue. */
  command: Command
  issues: Issue[]
  usage: Usage
  latencyMs: number
}

/**
 * The SDK's zodOutputFormat emits `$defs` for a repeated sub-schema and the API rejects `$defs`
 * under a union, so the schema is inlined here and the SDK's own parser still validates the reply.
 */
function commandFormat() {
  const format = zodOutputFormat(CommandSchema)
  const {
    $schema: _,
    oneOf,
    ...rest
  } = z.toJSONSchema(CommandSchema, {
    reused: 'inline',
    target: 'draft-2020-12',
  }) as Record<string, unknown>
  return { ...format, schema: { ...rest, anyOf: oneOf } }
}

let shared: Anthropic | undefined

/** One keep-alive client per process; reads ANTHROPIC_API_KEY from the environment. */
function defaultClient(): Anthropic {
  shared ??= new Anthropic()
  return shared
}

export async function parseMessage(input: {
  text: string
  /** The Argentine calendar day, yyyy-mm-dd. */
  today: string
  recentMovements: RecentMovement[]
  model: ModelKey
  client?: Anthropic
}): Promise<ParseResult> {
  const config = MODELS[input.model]
  const client = input.client ?? defaultClient()
  const started = performance.now()
  const response = await client.messages.parse({
    model: config.id,
    max_tokens: 2048,
    thinking: config.thinking,
    output_config: { effort: config.effort, format: commandFormat() },
    // Frozen prefix under one cache breakpoint; everything per-request comes after it.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: renderVolatile({
          text: input.text,
          today: input.today,
          recentMovements: input.recentMovements,
        }),
      },
    ],
  })
  const latencyMs = performance.now() - started
  if (response.parsed_output == null) {
    throw new Error(`model returned no parsable command (stop_reason: ${response.stop_reason})`)
  }
  const { command, issues } = validateCommand(response.parsed_output, input.today)
  return {
    command,
    issues,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    latencyMs,
  }
}
