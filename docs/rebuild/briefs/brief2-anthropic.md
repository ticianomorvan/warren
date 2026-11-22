ANTHROPIC API BRIEF for the council: Warren's use of Claude Haiku 5.5 and `@anthropic-ai/sdk` 1.10.0, as of 2026-11-22.

**Sourcing.** The claude-api skill docs are the source for every API claim, and each carries a tag.
- `[MM]` is `shared/model-migration.md`, section "Migrating to Claude Haiku 5.5". The skill's price table is cached 2026-11-03.
- `[TU]` is `shared/tool-use-concepts.md`.
- `[PC]` is `shared/prompt-caching.md`.
- `[LAT]` is `shared/latency-optimization.md`.
- `[TC]` is `shared/token-counting.md`.
- `[SDK]` is the installed `node_modules/@anthropic-ai/sdk` 1.10.0 typings.
- `[W]` is Warren's own code or `docs/agent-spec.md`.

I did not fetch platform.claude.com live. Anything marked "unverified live" should be checked against the live docs before it drives a decision.

## 1. Facts about Haiku 5.5

**Tool choice**
- **Forced calls work on Haiku 5.5.** `tool_choice` `any` or a named tool is accepted, with thinking on too [MM]. The response then starts with the tool call and has no thinking block [MM].
- **They 400 on other models.** Fable 5.2/5.1, Mythos, Opus 5.5 and Sonnet 5.5 return a 400 for forced `tool_choice` [TU]. On those models the documented substitute is `auto`, a prompt instruction naming the tool, and `strict: true` [TU].
- **`disable_parallel_tool_use` still works with `auto`** and gives at most one call [TU].
- **Warren has a second model key.** `ModelKey` includes `sonnet` (`models.ts:3,29`). A registry that relies on `tool_choice: any` is therefore valid for Haiku only. The `sonnet` key would 400 on every request, so either drop that key or make `tool_choice` per-model.

**Thinking and effort**
- **Thinking is on by default.** Haiku 5.5 runs adaptive thinking when `thinking` is unset [MM].
- **Disabling thinking:**
  - `thinking: {type:"disabled"}` is accepted only at effort `low`, `medium` or `high`; it 400s at `xhigh` and `max` [MM].
  - `between_tools` is Sonnet-5.5-only and 400s on Haiku [MM].
- **Effort default.** The default effort is `medium` [MM]. To get less thinking, lower the effort. In Anthropic's tests the model still thought when the prompt told it to answer directly [MM].
- **Effort changes mid-conversation.** A top-level effort change between requests invalidates the message cache. Per-message effort is a beta (`mid-conversation-output-config-2026-07-01`), keeps the cache, and 400s when thinking is off [MM].
- **Known `low`-effort behaviour:** the model is more likely to skip a search, stop early or skip a check [MM].
- **Known thinking-off behaviour:** with thinking off and a request that also asks for JSON output, the model "may skip a needed tool call". Anthropic lists three mitigations [MM]:
  - leave thinking on;
  - drop the output format;
  - force the call with `tool_choice`.

**Sampling and prefill**
- Non-default `temperature`, `top_p` and `top_k` return a 400. On API version `2026-10-21` any value of them does [MM].
- Assistant prefill returns a 400 [MM].

**Structured outputs and strict tools**
- `strict: true` and `output_config.format` are supported on Haiku 5.5 [TU].
- Strict requires `additionalProperties:false` and rejects `minimum`/`maximum` and string-length constraints. The first request with a new schema pays a compile cost and is then cached for 24 hours [TU].
- Warren measured strict at +0.2 to 0.33 s per call, plus about 10 s of cold compile after a schema change [W agent-spec ~916-923, 211].

**Stop reasons**
- The SDK type is `'end_turn'|'max_tokens'|'stop_sequence'|'tool_use'|'pause_turn'|'refusal'|'model_context_window_exceeded'` [SDK messages.d.ts:4146].
- Refusals:
  - A refusal is HTTP 200 with `stop_reason:"refusal"` and `stop_details.category` in `cyber`, `bio`, `frontier_llm`, `general_harms`. `stop_details` is null otherwise [MM, SKILL].
  - **Haiku 5.5 has no server-side `fallbacks`.** Adding `fallbacks:"default"` leaves the refusal in place, and a model list 400s [MM]. Handle the refusal in the client.
  - Content after a refusal may not match the schema [TU].
- `pause_turn` appears only with server tools [TU]. Warren declares none, so it cannot occur.
- `max_tokens` with a `tool_use` block present means the input may be a truncated partial object [TU].

**Tool results**
- When a tool fails, return `tool_result` with `is_error:true` and an informative message [TU].
- All results of one turn go in a single user message. Splitting them silently trains the model out of parallel calls [SKILL].
- Never put user text inside a `tool_result`. Put it as a text block after the results and keep harness notices in a separate system message [MM].

**Caching**
- **Minimum prefix.** The minimum cacheable prefix is 512 tokens, "check the docs before relying" [PC]. Warren's ~17k-token prefix is far above it.
- **Hits and invalidation.**
  - The prefix renders in the order tools, then system, then messages. A byte change at position N invalidates everything from N on [PC].
  - Any change to a tool, or reordering tools, invalidates the whole cache. Serialize tools deterministically [PC].
  - Changing the model invalidates the cache [PC].
  - A top-level effort change invalidates the message cache [MM].
- **TTL.** The 1h TTL costs a 2x write against 1.25x for 5 minutes. A read refreshes the timer, which is measured from the start of the request [PC]. For gaps of 5-60 minutes, 1h is the right choice [PC].
- **Ordering.** A 1h entry must appear before 5m entries [PC].
- **Pre-warming.** `max_tokens: 0` returns `content:[]` immediately. It bills the cache write and zero output [PC].
- **Healthy-loop check.** Verify `usage.cache_read_input_tokens` after every change. Total prompt size is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` [PC].
- **Haiku 5.5 retains thinking blocks.** Thinking blocks from earlier turns are kept by default, so a plain user message after tool use no longer strips them from the cached prefix [MM].
- **Mid-conversation system messages.** `{role:"system"}` appended to `messages` is supported on Haiku 5.5 with no beta header. It must follow a user turn, cannot be `messages[0]`, and is text-only [PC, MM]. The turn-scoped variant (`clear_at`) needs a beta [PC]. This is the supported home for per-message context that would otherwise live in a user turn.

**History editing**
- **The check.** A thinking block stays valid only while everything before it is unchanged. Otherwise the request 400s. This is enforced by default for accounts created on or after 2026-08-31 and, on older accounts, only when `thinking.block_binding.prefix_mismatch_behavior` is set [MM].
- **Thinking off.** `block_binding` 400s when thinking is disabled [MM]. With thinking off there are no thinking blocks, so there is nothing to invalidate.
- **The rule that follows.** Whoever turns thinking on later must keep the history append-only. Warren's loop is append-only today (`loop.ts:394`).

**Tokens and counting**
- Haiku 5.5 uses a newer tokenizer, about 30% more tokens than Haiku 4.5 for the same text [MM].
- Count with `messages.count_tokens` using the same model ID. `tiktoken` undercounts Claude by 15-20% or more [TC].
- Prompts over 100K tokens move to the higher price card [MM]. Warren's prefix is about 17k, so this does not apply.

**Latency**
- **The latency equation.** Task time is calls × time-to-first-token + output tokens ÷ output speed + everything else [LAT].
- **Parallel calls.** Independent tools in one turn should run concurrently, and their results should return together [LAT].
- **Streaming.** It lets a reader start at the first output, which matters for text shown to a person [LAT]. Warren's replies are rendered by code after the whole call, so streaming gains only the model's output time, and Warren measured that as "nearly free" [W agent-spec ~916].
- **Eager input streaming.** It exists for large tool inputs. It removes API validation and the tolerant parser can return silently truncated input [SKILL, TU]. It is not relevant to short calls like these.
- **Tools and structured outputs.** For a final answer, structured outputs (`output_config.format`) are the recommended path when a forced call only existed to get JSON back [TU]. They are incompatible with citations and prefill [TU].

## 2. SDK 1.10.0 idioms (verified against installed typings)

- **Client and requests.**
  - The default timeout is 10 minutes and `maxRetries` defaults to 2. Retries cover 408/409/429/5xx and connection errors, so worst-case wall time is `timeout × (retries+1)` [SDK client.d.ts:103,137; SKILL].
  - Per-request options take `{signal, timeout, maxRetries}`. `signal` aborts the call and its retries.
- **Types.** The SDK exports `Anthropic.MessageParam`, `Tool`, `ToolUseBlock`, `ToolResultBlockParam` and `Message`, and the skill says to use them instead of redefining [SKILL].
- **Zod helpers.**
  - Installed: `helpers/beta/zod` exports `betaZodTool` and `betaZodOutputFormat`, and `helpers/zod` exports `zodOutputFormat` [SDK].
  - Validation: the typed runner helpers validate the input against the Zod schema and never call `run` on invalid input [TU].
  - Constraints: for output formats, the SDK removes unsupported constraints from the schema it sends and validates them client-side [TU].
- **Tool Runner.**
  - Available as `client.beta.messages.toolRunner` with `max_iterations`, `setMessagesParams`, `generateToolResponse` and `runUntilDone` [SDK BetaToolRunner.d.ts:40-260; TU].
  - Per-turn hooks cover approval gating, error interception, result modification (including `cache_control`), retries and parameter changes [TU].
  - It lives under `client.beta.*` and exposes beta request shapes.
  - Its loop ends when the model stops calling tools [TU].
  - Not expressible (my analysis of the loop above, not a documented limit):
    - **Terminal tools.** There is no "this call ends the loop and nothing goes back to the model" concept.
    - **Held writes.** Holding writes while a search runs in the same turn (`loop.ts:360-381`) is not expressible.
    - **Repair re-asks.** Re-asking after a failed numbers check on text (`loop.ts:365-380`) is not expressible. This is the hook-and-`setMessagesParams` route, which the skill says covers "conditional execution", so it is arguable rather than impossible.
    - **Commit point.** The loop deliberately writes nothing before the commit point, so tool `run` functions would have to be no-ops.
  - The skill calls the manual loop legitimate "when your control flow doesn't fit the runner's per-turn hooks" [TU].

## 3. Where our code duplicates, misuses or under-uses the API/SDK

**A. Misuse or stale claims**
1. **`loop.ts:270`.** The comment says "tool use cannot be forced on every model". It is true for Sonnet 5.5, Opus 5.5 and the Fable/Mythos 5.1+ models. It is false for Haiku 5.5, the production model [MM]. `NO_TOOL` retry (`loop.ts:162,269-286`) costs one full extra model call (about 0.8 s fixed [W agent-spec ~916]). `tool_choice:{type:'any'}` removes that class on Haiku. The cost is that the forced path skips thinking [MM], which Warren already disables. The `sonnet` key in `models.ts:3` would 400, so any forcing must be conditional on the model or the key dropped.
2. **`loop.ts:266`.** Only `max_tokens` is handled. `stop_reason:'refusal'` is not handled anywhere (grep of `src/` finds no use). A refusal returns 200 with no `tool_use`, so `loop.ts:269` treats it as "no tool call" and re-asks with `NO_TOOL` (assistant turn pushed at `loop.ts:280`). That wastes a turn and may refuse again. `stop_details.category` is discarded, so audits cannot tell a safeguard decline from a model that wrote prose.
3. **`loop.ts:266`.** `max_tokens` with a partial `tool_use` is caught only by an unconditional throw before the calls are read. That matches the docs (partial inputs parse as valid objects [TU]) and is correct. `max_tokens: 2048` at `loop.ts:247` is far above the observed 24-132 output tokens.
4. **`models.ts:24`.** `thinking:{type:'disabled'}` is valid at effort `low` only because both are set together in `loop.ts:139`. Nothing couples them. If someone raises effort to `xhigh`, every request 400s. Effort and thinking should be one config object per model (`ModelConfig` holds `thinking`; `output_config` is hard-coded in `requestBase`, `loop.ts:139`).
5. **`models.ts:8-9`.** The price table is hand-copied from the cached skill table. Haiku 5.5 has two rate cards (prompts over 100K tokens cost more [MM]). `estimateCostUsd` ignores that. It is harmless at 17k, but wrong if context grows. The 100K threshold is not documented in `models.ts`.
6. **`loop.ts:401-406`.** `is_error` is true for every non-read result, including the "held" and "refused" answers. That matches the documented use for failures [TU]. A result for a valid action that was only held is not an error in the API's sense, so is_error semantics are loose. It is not a bug.
7. **`loop.ts:408`.** `LAST_TURN` is appended as a text block after the results in the same user message. That is the documented shape for non-tool text [MM], so this is correct.

**B. Duplication of what the SDK or API already ships**
8. **`tools.ts:38-52` plus `schema.ts`.** `inputSchema` re-implements schema cleanup on top of `z.toJSONSchema`. It strips `minimum`, `maximum`, `default` and `$schema`. The SDK's `betaZodTool` and `betaZodOutputFormat` do the same job with validation [SDK zod.d.ts:14,24; TU]. The strip is now only for prompt size, since strict is off [W]. `schema.ts` also keeps factories "because the API rejects the `$defs` that a reused schema produces". That is a strict-era constraint. It should be re-tested before the registry copies it.
9. **`loop.ts:246-249`, `loop.ts:259-264`.** Usage accounting is hand-rolled (five counters plus `estimateCostUsd`). The fields are the documented ones. It is not wrong, but it is duplicated between `TurnTiming` and `Usage`.
10. **`models.ts:3-34` plus the `requestBase` in `loop.ts:136-148`.** Every request-shape decision (thinking, effort, tools, system, TTL) is split across two files and `warmUp`. The skill's guidance is that forks must reuse the parent's exact tools, system and model [PC]. The code does that via `requestBase`. This is a structural strength, not a defect.
11. **`loop.ts:154-160` `warmUp`.** It sends `max_tokens: 16` and a user message `'ping'` to write the cache. The documented way is `max_tokens: 0`, which returns immediately with no output billed [PC]. This is a small waste (16 output tokens of Haiku) and a stylistic gap.

**C. Under-used**
12. **Caching.**
    - **Context placement.** The volatile per-message context is the first user message (`loop.ts:193-202`). That is correct placement: after the cached prefix [PC]. Mid-conversation `role:"system"` (no beta on Haiku 5.5 [MM]) is available for the context block but is not necessary. `role:"system"` is the non-spoofable operator channel, whereas a user turn can carry injection from the person's text [PC]. The context contains person data and facts, so this is a design choice, not an obvious win.
    - **Automatic caching.** Top-level auto-caching is not used. Because turns 2-3 repeat the whole prior conversation, they re-read the prefix and pay full price for the growing tail (`messages.push` at `loop.ts:394,409`). Auto-caching or an explicit breakpoint on the last tool-result block could cache the tail, but those are 1-2 short turns, so the gain is small. Measure `cache_read` on turn 2 first.
    - **Cost check.** `TurnTiming` records `cache_read` and `cache_write` per turn (`loop.ts:250-258`). The healthy-loop signature to check is that turn 2 reads the whole turn-1 prefix and writes only the delta [PC].
13. **Token counting.** `count_tokens` is never used (grep of `src/`). The ~17k-token prefix and the ~34 KB + ~17.6 KB prompt are not counted per model. Any prompt change (for example generating the prompt from a registry) should be gated on a `count_tokens` diff on `claude-haiku-5-5` [TC].
14. **Per-message effort.** It is a beta that keeps the cache and needs thinking on [MM]. It cannot be used while thinking is disabled, so it is unavailable to Warren as configured.
15. **Parallel tools.** The loop runs reads sequentially (`for (const call of calls)` with `await i.env.find`, `loop.ts:310-317`). The documented guidance is concurrent execution of independent read-only calls [LAT]. Only `find_movements` is a read, so this matters only when the model sends several searches in one turn. Hold-and-resend semantics already serialize the second turn.
16. **Streaming.** Not used (`messages.create` only, `loop.ts:246`). Per [LAT], streaming helps a reader only when output is shown incrementally. Warren renders replies by code after the call, and the output is 24-132 tokens, so there is nothing to stream. Do not add it. A start-reads-as-calls-finish pattern [LAT] could shave one search's latency off turn 1 but needs streaming and is not worth it at p50 ~2 s.
17. **Retries and signals.** `server.ts:28` builds the client with a custom `fetch` (`keepAliveFetch`) and the default `maxRetries: 2`. The loop passes `signal` (`loop.ts:248`) from the message deadline and shutdown. This is the documented idiom. Check that the combined deadline caps the retry total, since `timeout` and retries multiply [SKILL client-config note]. `process.ts:714` has a second `new Anthropic()` with default settings (`shared ??= new Anthropic()`) that bypasses `keepAliveFetch`. That is worth reconciling.
18. **Structured output for terminal answers.** The terminal tools (`reply`, `ask_user`, and so on) are the right primitive here because they can carry a verb, so that is a choice the owner already made. `output_config.format` would replace only the `reply`-style tools, and the skill warns that Haiku with thinking off and a JSON format may skip a needed tool call [MM]. That is a risk of mixing the two, so keep tools only.

## 4. Implications for the proposed redesign

- **`tool_choice:any` with a one-turn "match" resolution.** This is valid on Haiku 5.5 [MM] and removes the `NO_TOOL` re-ask. It is a per-model setting. Because `any` skips thinking, quality must be re-measured on the scenario eval. Warren already runs thinking off, so the expected change is small [W models.ts:24].
- **`skip {part, reason}` terminal.** It is an ordinary tool (nothing API-specific).
- **Registry-generated prompt and tools.** The tool list is part of the cached prefix. Any registry change reorders or rewrites bytes and invalidates the 1h cache on deploy. Serialize deterministically (sorted by name or fixed order) and re-run the warm-up after deploy [PC]. The current `TOOLS` order is already fixed by `Object.keys(TOOL_INPUTS)` (`tools.ts:61`).
- **Refusal handling belongs in the loop.** Branch on `stop_reason` before reading `content` [MM]. Retry once is pointless for `cyber`/`bio` categories, so fail with the failure notice and log `stop_details.category`.