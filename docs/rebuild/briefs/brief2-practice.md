**AGENT-PRACTICE BRIEF for the council: Warren at 066eb87.** I read only the AGENTS.md and agent-spec parts I needed. The repo grep lines below are from this session. Where a source is weak, I say so.

## 1. Tool and action design for agents that change user data

**What current practice says**
- Anthropic's tool docs say descriptions are "by far the most important factor". They advise consolidating related operations into fewer tools with an `action` parameter. They also say to return "semantic, stable identifiers" and only high-signal fields. [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- Anthropic's engineering post says agents "grapple with natural language names, terms, or identifiers". It reports that mapping UUIDs to more meaningful language, or to a 0-indexed scheme, cut hallucinations. It also suggests a `schedule_event`-style tool that finds availability and books in one call. It asks for errors that are actionable. [writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
  - This is about what the model sees, not about letting the model name the target. An index or short id the model copies from a list is consistent with it.
  - A secondary summary says the guidance is partly about tool results. I read the primary page only through a small model.
- Forced tool use is model-dependent. [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
  - `tool_choice` `any` or `tool` returns 400 on Opus 5.5, Sonnet 5.5, Fable 5.x and Mythos 5.x.
  - The same page says Haiku 5.5 accepts it. A forced call skips thinking, and the response starts with the tool call.
  - Changing `tool_choice` invalidates cached message blocks. Tools and system stay cached.
- The Haiku 5.5 guide has a related warning. With thinking off and JSON output, Haiku "might skip a tool call it needs". Forcing the call restores it. [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)
- Strict tool use guarantees schema-valid inputs. [strict-tool-use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
  - The first use of a schema pays grammar-compile latency. Compiled grammars are cached 24 h.
  - The cache is invalidated by schema-structure changes or a change to the tool set.
  - This matches the repo's measurement of 0.2-0.33 s per call, so keeping it off is consistent with the docs.
- Confirm versus undo. The sources are practitioner posts, not studies. [AWS Builder Center](https://builder.aws.com/content/3Ld3UC6x9JtcEaL1Q31Lt49e0lf/keep-the-friction-where-it-matters-designing-confirmations-by-reversibility-not-convenience), [dev.to, undo button](https://dev.to/prpatel05/give-your-agent-an-undo-button-3bh3), [dev.to, human-in-the-loop](https://dev.to/gantz/human-in-the-loop-when-ai-agents-should-stop-and-ask-30gc)
  - Gate irreversible actions, and use undo or soft deletes for reversible ones.
  - Blanket confirmation causes approval fatigue.
  - Confirmation does not help after a confirmed write turns out wrong.
  - In a CRM-agent example, an unrelated message cancels the pending action.
- A search-then-act sequence is the normal agent pattern. I found no 2025-2026 source measuring one-turn match-resolved-by-code against two turns, so that evidence would be Warren's own to produce.

**Repo comparison**
- Undo with a visible before/after and reminders as soft state fit the "undo over confirm" practice.
- `delete_movement` and `correct_movement` take only an id (`src/agent/tools.ts:8-9`). The only read tool is `find_movements` (`tools.ts:7`). A request outside the 10 newest movements costs a read turn and then an act turn.
- The repo comment says "tool use cannot be forced on every model" (`loop.ts:~270`, `agent-spec.md:191`). Haiku 5.5 can be forced and Sonnet 5.5 cannot, and `models.ts:23-31` has both. A forced `any` would have to be Haiku-only, with `auto` plus `NO_TOOL` retry kept for Sonnet.
- Haiku runs with `thinking: disabled` and effort `low` (`models.ts:24`, `loop.ts:~138`). The Haiku guide ties skipped tool calls and reasoning-like text in replies to that combination, and that is the failure the NO_TOOL branch handles.

## 2. Who writes the reply, and guarding numbers

**What current practice says**
- The consistent recommendation in the finance-hallucination material is to keep numbers out of free generation. Compute them or take them from source, check them, then render them through a template.
  - FAITH finds models still err at identifying, calculating and presenting numbers from tables. [arXiv 2508.05201](https://arxiv.org/abs/2508.05201)
  - VeNRA uses a separate small verifier for arithmetic invariants. [arXiv 2603.04663](https://arxiv.org/html/2603.04663v1)
  - FrontierFinance found agents showed no meaningful self-verification. [arXiv 2604.05912](https://arxiv.org/pdf/2604.05912)
  - These sources are benchmarks and proposals. A DEV postmortem backs checking numeric values after structured output, but it is anecdotal. [dev.to postmortem](https://dev.to/johalputt/postmortem-how-a-gpt-4o-hallucination-caused-incorrect-billing-calculations-for-1k-enterprise-5210)
- Structured outputs constrain shape, not truth. A schema-valid number can still be wrong, so the check has to compare against a source set. [structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- Haiku 5.5 "sometimes writes reasoning-like text in the reply that users see", more with thinking off or at low effort. [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5) Free model text is therefore the riskiest path on this exact configuration.
- Safeguard refusals arrive as HTTP 200 with `stop_reason: "refusal"`. Haiku 5.5 has no server-side fallback, and resending the same request "usually returns another refusal". [handling-stop-reasons](https://platform.claude.com/docs/en/api/handling-stop-reasons)

**Repo comparison**
- Records and figures come from code. Model text is optional and checked by `say.ts`.
- The check is regex-based:
  - A `CLAIMS` table of first-person past-tense claims (`say.ts:115`, with a `NOT` negation lookbehind at ~112).
  - A hand-listed `NUMBER_WORDS` list plus open families (`say.ts:21-70`, `NUMBER_WORD_RE`).
  - A `KIND_OF_TOOL` map (`say.ts:95`).
  - This is the "wording dependency on render.ts" the file admits (`say.ts:~104`).
  - The sources above support the numbers half. The claims and wording half is a Spanish regex list I found no precedent for, and it is the part that grows with every wording change.
- The `text` field is on 13 tools (`schema.ts:208` shows `Say()` on `set_reminder`). The same guard has to be applied to each.
- The loop does not handle `refusal`. A refusal has no tool call, so it falls into the no-tool branch and re-asks Haiku with `NO_TOOL` (`loop.ts:266-283`, `calls.length === 0`). That resends the same request, which the docs say usually refuses again. It costs a turn and ends in an error or a canned fallback.

## 3. One registry for agent and MCP tools

**What current practice says**
- The MCP TypeScript SDK `registerTool` takes Zod `inputSchema` and `outputSchema`, validates input before the handler, and requires `structuredContent` to match `outputSchema`. [v2 server docs](https://ts.sdk.modelcontextprotocol.io/v2/documents/Documents.Server_Guide.html) v2 is a beta that tracks the 2026-07-28 spec. [v2 landing](https://ts.sdk.modelcontextprotocol.io/v2/)
- Define the Zod schema once and derive each consumer's schema from it. Use Zod 4's native `z.toJSONSchema` with `target: "draft-2020-12"` and inline `$ref`/`$defs`, because draft-07 output from `zod-to-json-schema` caused 400s in some clients. [zod.dev/json-schema](https://zod.dev/json-schema), [MCP SDK issue 925](https://github.com/modelcontextprotocol/typescript-sdk/issues/925)
- Anthropic's tool docs say to namespace tools by service, for example `github_list_prs`. [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- Gap: I found no published pattern for a catalogue feeding both an Anthropic-messages tool list and MCP `registerTool`. The sources are SDK docs and issues, not reference architectures. Treat the registry shape as the repo's own design.
- On sentinels: the Zod-to-JSON path keeps optional fields out of `required`. The tool docs' own examples omit optional fields rather than sending nulls. [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

**Repo comparison**
- `tools.ts` already derives JSON from Zod with `z.toJSONSchema`, but it strips `minimum`, `maximum` and `default` itself (`tools.ts:36-52`) and keeps a separate `DESCRIPTIONS` record (`tools.ts:5-33`).
- The write-tool lists are duplicated, as council 1 said:
  - `apply.ts:39` (`WRITE_TOOLS`)
  - `execute.ts:77` (`CHANGES`)
  - `say.ts:95` (`KIND_OF_TOOL`)
- MCP re-declares inputs and outputs, with its own descriptions and `OUTPUTS` (`mcp/tools.ts:128-147`), and registers each tool by hand (`mcp/tools.ts:422, 471, 513`).
- Sentinels exist: the `forget_fact` description says "leave the other 0 or ''" (`tools.ts:24`). The 2025-2026 guidance does not endorse sentinel values.
- The doc-recommended `input_examples` field is unused. It is validated against `input_schema` and costs about 100-200 tokens each. [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

## 4. Prompts for small fast models

**What current practice says**
- Put static content (tools, system, examples) first and mark the end with `cache_control`. Dynamic content comes after. Caching covers tools, then system, then messages. [prompt-caching](https://platform.claude.com/en/docs/build-with-claude/prompt-caching)
- Haiku 5.5 guidance: add the current date in the newest turn when a conversation continues across days, and keep `system` and `tools` identical across requests. [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5) Changing `output_config.effort` between requests invalidates the message cache.
- Examples: 3-5 relevant, diverse examples in `<example>` tags. [prompting best practices](https://platform.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Remove over-prompting. "If in doubt, use [tool]" over-triggers, and "CRITICAL: You MUST" should become plain wording. The page says that for Opus 4.5/4.6-era models. The same page asks for plain wording on newer models too. [prompting best practices](https://platform.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Long Haiku prompts at low effort can cause early stopping. Moving from low to medium effort roughly halved it in Anthropic's testing but more than doubled output tokens. [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)
- Gap: I found no source on generating prompts from a tool registry, or on the best rule-to-example ratio. A ~34 KB rules plus ~17.6 KB examples split is outside anything the docs give a number for.

**Repo comparison**
- The prefix is frozen under one 1 h breakpoint (`loop.ts:~140-148`). The per-message context goes in the user turn (`prompt.ts:535`, `renderContext`). That is the documented layout.
- The prefix is much larger than the docs' 3-5 examples guidance (about 17k tokens).
- Effort is `low` (`loop.ts:~138`), the setting the Haiku guide ties to early stopping and skipped checks. The repo's measured results contradict a problem here (second model turn on 3.1% of turns, `agent-spec.md:1142`). Keep it, but pair any prompt growth with that measurement.

## 5. Relative dates and times

**What current practice says**
- The pattern is for the model to extract an expression and for code to resolve it against an anchor.
  - Facebook's Duckling is the rule-based option. LLMs struggle with compositional phrases. [Towards Data Science](https://towardsdatascience.com/extracting-information-from-natural-language-using-generative-ai-ed64dcf1de66/)
  - A 2026 clinical pipeline never asks the model to do calendar arithmetic. It uses `dateparser` for deterministic normalization. [arXiv 2605.26560](https://arxiv.org/pdf/2605.26560)
  - LLM-only normalization with window prompts exists in research. [arXiv 2404.07775](https://www.arxiv.org/pdf/2404.07775)
  - I found no source specific to reminders, or to Argentine Spanish ("el 5", "fin de mes").
- Haiku 5.5 benefits from the current date in the prompt. [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)

**Repo comparison**
- `range.ts` is the code-side resolver for summaries, and it is already the right direction. It parses `yyyy-mm-dd`, `mm-dd` and `dd` as endpoints (`range.ts:48-76`) and resolves "el 5" the Argentine way.
- The `other` comparison range is a mini-language string (`month:10:2025`, `dates:11-01..11-15`) parsed by hand (`range.ts:295-331`, `parseOther`). A discriminated union would replace the string parsing and its error text.
- `set_reminder` makes the model compute the first date: `schedule.start` is "yyyy-mm-dd, today or later" (`tools.ts:30`, `schema.ts:208`). That is calendar arithmetic by the model, which the sources above avoid, and code only checks it is in the future.

## Simplifications current practice allows here

1. **Handle `stop_reason: "refusal"` as terminal** and do not resend it. At `loop.ts:266-283`, branch on `refusal` before the `calls.length === 0` path. Say it once through a canned line and log `stop_details.category`. Source: [handling-stop-reasons](https://platform.claude.com/docs/en/api/handling-stop-reasons).
2. **Force a tool on Haiku 5.5 only.** Add `tool_choice: {type: 'any'}` for Haiku, and keep the `auto` plus NO_TOOL retry path for Sonnet 5.5 (`models.ts:30`). This could delete most of the no-tool turn (`loop.ts:267-283`), but measure first. It skips thinking, which `models.ts:24` already disables for Haiku. It changes the message-cache key (the first message is reprocessed) but not the frozen prefix. Sources: [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [Haiku guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5). The earlier review's `any` proposal is valid on Haiku and invalid on Sonnet.
3. **One registry entry per tool** feeds `TOOLS` (`tools.ts:5-65`), the write lists (`apply.ts:39`, `execute.ts:77`, `say.ts:95`) and MCP `registerTool` (`mcp/tools.ts:422+`). Use `z.toJSONSchema(..., {target: 'draft-2020-12'})` for the agent tools. Drop the hand-written `strip()` (`tools.ts:36-52`) for one shared helper. No source shows this exact shape, so it is a design call.
4. **Delete the sentinel fields.** For `forget_fact`, split into id and key variants, or a union, instead of "0 or ''" (`tools.ts:24`). Sources: [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
5. **Move the model's free text out of 13 action tools.** The numbers check (`say.ts:357`, `checkSay`) is supported by the finance-hallucination sources. The claims and wording regexes (`say.ts:115`, `NUMBER_WORDS` at `say.ts:21-70`) are not. Keeping free text only in `reply` shrinks the surface those regexes guard. This is the earlier review's proposal and I found nothing that argues against it.
6. **Relative reminder time as structured input**, for example `{in: {unit, n}}` or `{day, time}`. Code resolves against `today`, like `range.ts`. This removes "first date, today or later" from the model (`schema.ts:208`). Sources: [arXiv 2605.26560](https://arxiv.org/pdf/2605.26560), [Duckling article](https://towardsdatascience.com/extracting-information-from-natural-language-using-generative-ai-ed64dcf1de66/).
7. **Make `other` a typed range** and delete `parseOther` (`range.ts:295-331`). It is code that exists only to parse a string the model could send as a union.
8. **Use `input_examples` on the few complex tools** (`set_reminder`, `summarize`) before adding prose to the 34 KB rule block. Each example costs about 100-200 tokens and is validated against the schema. Source: [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

**What I could not find.** There is no published evidence on id-or-match resolution by code against ids, on registry-generated prompts for small models, or on rule-to-example ratios. Those three would need Warren's own scenario eval to decide.