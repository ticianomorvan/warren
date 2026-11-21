# Model bench

Runs Warren's 131 eval cases against other models with the production prompt (`src/parse/prompt.ts`),
schema, `validateCommand` and grader unchanged. Nothing here changes the product.

```sh
set -a && . ./.env && set +a      # ANTHROPIC_API_KEY, OPENROUTER_API_KEY
pnpm tsx evals/bench/run.ts --run smoke --limit 5 --chunk 5
pnpm tsx evals/bench/run.ts --run full           # 131 cases, concurrency 2, US$3 cap
```

- `candidates.ts`: the models, their pinned OpenRouter provider and reasoning setting.
- `openrouter.ts`: plain-`fetch` adapter. Strict `json_schema` from `z.toJSONSchema`, pinned provider
  (`allow_fallbacks:false`, `require_parameters:true`), `usage:{include:true}` for the real cost.
  `wrap` nests the union under `{command}` (OpenAI, Mistral and Groq reject a root `anyOf`).
- `run.ts`: rotates candidates in chunks of 11 cases so provider variance hits all alike; the
  control (`haiku-direct`) is the existing `parseMessage`. Latency is the wall time of the HTTP call.
- `results/<stamp>-<run>/`: per-candidate JSON and `summary.md`. Held-out (test) cases keep only
  aggregates and timings. `results/spend.jsonl` is the running spend that enforces the cap.

Dropped: Haiku 5.5 on Amazon Bedrock. OpenRouter lists no `structured_outputs` for that endpoint and
answers 404 to any `json_schema` request (see `DROPPED` in `candidates.ts`).
