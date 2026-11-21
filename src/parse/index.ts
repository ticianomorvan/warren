import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { MODELS, type ModelKey, type Usage } from './models'
import { renderVolatile, SYSTEM_PROMPT } from './prompt'
import { type Command, CommandSchema, type PreviousExchange, type RecentMovement } from './schema'
import { type Issue, validateCommand } from './validate'

export type { ModelKey, Usage } from './models'
export { estimateCostUsd, MODELS } from './models'
export type {
  Changes,
  Command,
  Movement,
  Period,
  PreviousExchange,
  RecentMovement,
} from './schema'
export { CATEGORIES, CommandSchema } from './schema'
export type { Issue } from './validate'

export type ParseResult = {
  /** The model's command, validated; a failed check lowers confidence and adds an issue. */
  command: Command
  issues: Issue[]
  /** The issues that make a `log` unstorable; the caller must not store or guess it. */
  fatal: Issue[]
  usage: Usage
  latencyMs: number
}

const COMMAND_FORMAT = zodOutputFormat(CommandSchema)

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
  /** The sender's previous exchange, when it was recent and answered. */
  previous?: PreviousExchange | null
  model: ModelKey
  client?: Anthropic
  /** Aborts the call and the SDK's retries. */
  signal?: AbortSignal
}): Promise<ParseResult> {
  const config = MODELS[input.model]
  const client = input.client ?? defaultClient()
  const started = performance.now()
  const response = await client.messages.parse(
    {
      model: config.id,
      max_tokens: 2048,
      thinking: config.thinking,
      output_config: { effort: 'low', format: COMMAND_FORMAT },
      // Frozen prefix under one cache breakpoint; everything per-request comes after it.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: renderVolatile({
            text: input.text,
            today: input.today,
            recentMovements: input.recentMovements,
            previous: input.previous,
          }),
        },
      ],
    },
    input.signal ? { signal: input.signal } : undefined,
  )
  const latencyMs = performance.now() - started
  if (response.parsed_output == null) {
    throw new Error(`model returned no parsable command (stop_reason: ${response.stop_reason})`)
  }
  const { command, issues, fatal } = validateCommand(response.parsed_output, input.today)
  return {
    command,
    issues,
    fatal,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    latencyMs,
  }
}
