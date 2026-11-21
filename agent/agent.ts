import { defineAgent } from 'eve'
import { anthropic } from 'eve/models/anthropic'

/**
 * Warren's agent on eve: direct Anthropic, Haiku 5.5, no thinking, effort low. The workflow store is the
 * Postgres world (`WORKFLOW_POSTGRES_URL`), and none of eve's sandbox tools is on: the model reaches the
 * world only through the five ledger tools.
 */
export default defineAgent({
  model: anthropic('claude-haiku-5-5'),
  reasoning: 'none',
  modelOptions: {
    providerOptions: { anthropic: { effort: 'low', thinking: { type: 'disabled' } } },
  },
  defaultTools: false,
  experimental: { workflow: { world: '@workflow/world-postgres' } },
})
