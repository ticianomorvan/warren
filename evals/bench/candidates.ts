/** The models under test. Ids and provider slugs were checked against openrouter.ai/api/v1/models (2026-11-21). */
export type Candidate = {
  key: string
  label: string
  /** `anthropic`: the existing parseMessage (direct API). `openrouter`: the adapter in openrouter.ts. */
  via: 'anthropic' | 'openrouter'
  model?: string
  /** The one OpenRouter provider the request is pinned to (no fallbacks). */
  provider?: string
  /** The `reasoning` request field that turns thinking off, or to its lowest. */
  reasoning?: Record<string, unknown>
  /** Mark the system message with Anthropic-style cache_control (the others cache implicitly). */
  explicitCache?: boolean
  /** Wrap the schema as {command: <union>} for providers that reject a root anyOf. */
  wrap?: boolean
  maxTokens?: number
}

export const CANDIDATES: Candidate[] = [
  { key: 'haiku-direct', label: 'Claude Haiku 5.5, Anthropic API (control)', via: 'anthropic' },
  {
    key: 'haiku-vertex',
    label: 'Claude Haiku 5.5 via OpenRouter, Google Vertex',
    via: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'google-vertex',
    reasoning: { enabled: false },
    explicitCache: true,
  },
  {
    key: 'gpt6-luna',
    label: 'GPT-6 Luna (OpenAI), reasoning none',
    via: 'openrouter',
    model: 'openai/gpt-6-luna',
    provider: 'openai',
    wrap: true,
    reasoning: { effort: 'none' },
  },
  {
    key: 'mistral-small',
    label: 'Mistral Small 2603 (Mistral), reasoning none',
    via: 'openrouter',
    model: 'mistralai/mistral-small-2603',
    provider: 'mistral',
    wrap: true,
    reasoning: { effort: 'none' },
  },
  {
    key: 'gemini-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (Google AI Studio), thinking off',
    via: 'openrouter',
    model: 'google/gemini-3.1-flash-lite',
    provider: 'google-ai-studio',
    reasoning: { effort: 'none' },
  },
  {
    key: 'gpt-oss-groq',
    label: 'gpt-oss-120b (Groq), reasoning low',
    via: 'openrouter',
    model: 'openai/gpt-oss-120b',
    provider: 'groq',
    wrap: true,
    reasoning: { effort: 'low' },
    maxTokens: 4096,
  },
]

/**
 * Dropped before the full run: the provider cannot enforce our schema.
 * Amazon Bedrock (OpenRouter slug `amazon-bedrock`) lists no `structured_outputs` parameter. With
 * `response_format: json_schema` OpenRouter answers 404 "No endpoints found ... Filter by
 * Parameters removed claude-on-aws, amazon-bedrock", with or without `require_parameters`, strict
 * or not, wrapped or not. The same model answers JSON when only the prompt asks for it, but that
 * is not schema-enforced output.
 */
export const DROPPED: Candidate[] = [
  {
    key: 'haiku-bedrock',
    label: 'Claude Haiku 5.5 via OpenRouter, Amazon Bedrock',
    via: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'amazon-bedrock',
    reasoning: { enabled: false },
    explicitCache: true,
  },
]
