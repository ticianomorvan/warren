import { z } from 'zod'
import { CommandSchema } from '../../src/parse/schema'
import type { Candidate } from './candidates'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

type Json = Record<string, unknown>

/**
 * Zod's JSON Schema, reshaped for strict structured outputs: no `$schema`, `oneOf` as `anyOf`,
 * `const` as a one-value `enum`. With `wrap` the union sits under a root object `{command}`,
 * since some providers reject a root `anyOf`.
 */
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify)
  if (node === null || typeof node !== 'object') return node
  const out: Json = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue
    if (key === 'oneOf') out.anyOf = strictify(value)
    else if (key === 'const') out.enum = [value]
    else out[key] = strictify(value)
  }
  return out
}

export function responseSchema(wrap: boolean): Json {
  const union = strictify(
    z.toJSONSchema(CommandSchema, { target: 'draft-7', io: 'output' }),
  ) as Json
  if (!wrap) return union
  return {
    type: 'object',
    properties: { command: union },
    required: ['command'],
    additionalProperties: false,
  }
}

export type OpenRouterCall = {
  /** The model's text, or null when the answer carried none. */
  content: string | null
  finishReason: string | null
  /** Provider that actually served the request, as OpenRouter reports it. */
  servedBy: string | null
  httpStatus: number
  /** Wall time of the HTTP call, from fetch to the whole body read. */
  latencyMs: number
  attempts: number
  usage: {
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    /** US$ OpenRouter charged for this call (usage accounting). */
    costUsd: number | null
  }
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly latencyMs: number,
    readonly attempts: number,
  ) {
    super(message)
  }
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

export async function callOpenRouter(
  candidate: Candidate,
  input: { system: string; user: string },
  apiKey: string,
): Promise<OpenRouterCall> {
  const body = {
    model: candidate.model,
    max_tokens: candidate.maxTokens ?? 2048,
    messages: [
      {
        role: 'system',
        content: candidate.explicitCache
          ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
          : input.system,
      },
      { role: 'user', content: input.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'warren_command',
        strict: true,
        schema: responseSchema(candidate.wrap === true),
      },
    },
    provider: {
      order: [candidate.provider],
      allow_fallbacks: false,
      require_parameters: true,
    },
    ...(candidate.reasoning ? { reasoning: candidate.reasoning } : {}),
    usage: { include: true },
  }
  const payload = JSON.stringify(body)

  // One retry for a transport error, 429 or 5xx; a 4xx is the adapter's fault and is not retried.
  let attempts = 0
  for (;;) {
    attempts += 1
    const started = performance.now()
    let response: Response | undefined
    let text = ''
    let failure: string | null = null
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: payload,
      })
      text = await response.text()
    } catch (error) {
      failure = `transport: ${error instanceof Error ? error.message : String(error)}`
    }
    const latencyMs = performance.now() - started
    const status = response?.status ?? 0
    const retryable = failure !== null || status === 429 || status >= 500
    if (retryable && attempts < 2) continue
    if (failure !== null) throw new OpenRouterError(failure.slice(0, 300), 0, latencyMs, attempts)

    let json: Json
    try {
      json = JSON.parse(text) as Json
    } catch {
      throw new OpenRouterError(`http ${status}: non-JSON body`, status, latencyMs, attempts)
    }
    const errorField = json.error as { message?: string; code?: unknown } | undefined
    if (!response?.ok || errorField) {
      const detail = errorField?.message ?? text.slice(0, 200)
      throw new OpenRouterError(
        `http ${status}: ${String(detail).slice(0, 300)}`,
        status,
        latencyMs,
        attempts,
      )
    }
    const choice = (json.choices as Json[] | undefined)?.[0] as
      | { message?: { content?: unknown }; finish_reason?: string; error?: { message?: string } }
      | undefined
    const usage = (json.usage ?? {}) as Json
    const promptDetails = (usage.prompt_tokens_details ?? {}) as Json
    const completionDetails = (usage.completion_tokens_details ?? {}) as Json
    const content = choice?.message?.content
    return {
      content: typeof content === 'string' && content !== '' ? content : null,
      finishReason: choice?.finish_reason ?? null,
      servedBy: typeof json.provider === 'string' ? json.provider : null,
      httpStatus: status,
      latencyMs,
      attempts,
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        cachedTokens: num(promptDetails.cached_tokens),
        cacheWriteTokens: num(promptDetails.cache_write_tokens),
        reasoningTokens: num(completionDetails.reasoning_tokens),
        costUsd: typeof usage.cost === 'number' ? usage.cost : null,
      },
    }
  }
}
