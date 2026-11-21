# Spike: eve on top of Warren's core

Status: approved by Ticiano, 2026-11-21. This is a time-boxed spike. It ends in a decision report and a
draft PR. Nothing in it is merged or deployed unless we adopt eve afterwards.

## Goal

Ticiano's direction:

- Warren's core stays code-first: the ledger, movements, every figure, and the guards.
- [eve](https://github.com/vercel/eve) runs on top as the agent layer. It handles conversations, channels,
  connections and integrations.
- The agent should accept any input (free text, voice, images) and still act only through the core's tools.

The spike answers one question with numbers: **can eve run Warren's agent on top of the core, with every
guard intact, and at least the quality and speed of our own loop?**

We adopt eve if all of these hold on the same scenarios as our loop:

1. **Quality.** The scenario suite scores at least as well (read to about ±2 scenarios), with 0 silent wrong
   changes and 0 invented numbers.
2. **Speed.** Per-turn answer time p50 is within +300 ms of our loop's, and p95 within +600 ms.
3. **Guards.** Every guard below works through eve's own hooks (`execute`, `approval`, `defineState`, hooks),
   with no fork and no monkey-patching.

## Not doing

- Production. No Railway deploys, no production database, no change to the Meta webhook, and no messages from
  the test number. The orchestrator runs the live WhatsApp test after the report.
- OAuth or sign-in, a users table, reminders, and memory. For memory and reminders, report only how they
  would fit.
- Changing the core's rules (`AGENTS.md`) beyond what the spike needs. Note any rule eve forces us to bend.

## What exists (read these first)

- `AGENTS.md` holds the rules and layout. Follow it. Rule 2 (templated replies) is the one this spike
  revisits: the model may write its reply text, but every number in it must come from code (see Guards).
- `docs/agent-spec.md` covers the agent design and the slice B notes and results. Our loop scores 98/98 on
  `pnpm eval:scenarios --split all` with 0 silent changes. Its p50 is 1.84 s and its p95 3.33 s per turn.
- The core to wrap:
  - `src/ledger.ts` (all SQL on `movement`), `src/movement.ts` and `src/agent/validate.ts` (value rules);
  - `src/agent/calls.ts` (the guards that need no database), `src/render.ts` (money format), `src/time.ts`;
  - `src/store.ts` and `src/execute.ts` (the commit point).
  - Today an owner is a WhatsApp number (`wa_id`). Keep that as the user key for the spike.
- The scenario eval in `evals/scenarios/`: `drive.ts` plays a scenario through our pipeline, and `grade.ts`
  grades the database state plus `reply.has`.
- Two failures from the 2026-11-21 live test, which our loop also gets wrong:
  - **#48** `borra el súper y la nafta fue 4000`: the model searched and corrected in one turn, and the
    delete was silently dropped.
  - **#49** `borraste el super?`: the model could only answer with canned help text.
- eve's docs (version 1.3.x as of 2026-11-21), on eve.dev:
  - `/docs/concepts/execution-model-and-durability`, `/docs/tools`, `/docs/human-in-the-loop`;
  - `/docs/concepts/state`, `/docs/memory`, `/docs/agent-config`, `/docs/channels`, `/docs/channels/mcp`;
  - `/docs/guides/deployment/self-hosting`.
- Vercel's Chat SDK WhatsApp adapter: https://chat-sdk.dev/adapters/official/whatsapp

## Design to build

**Layout.** An eve project in the repo, for example `agent/` at the root or a workspace package. Choose the
layout that keeps the core importable without copying it, and say why. Pin `eve` to an exact version.

**Setup.**

- Model: direct Anthropic `claude-haiku-5-5` (`eve/models/anthropic`), not AI Gateway, with effort low and
  thinking off. Use prompt caching if eve passes provider options through. Report whether it does.
- Workflow store: `@workflow/world-postgres` on the throwaway local Postgres. Run
  `docker run --rm -d --name warren-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17`.
- Instructions: port `src/agent/prompt.ts` to `instructions.md` plus a per-turn context. That context is
  today's date and time and the 10 newest live movements with ids. Find where eve lets per-turn context in.

**Tools.** Each tool is a thin `defineTool` over the core:

- `find_movements` (read).
- `log_movements`, `correct_movement` and `delete_movement` (write). Each one validates, then commits in its
  own transaction through the core, then returns a code-rendered line, such as
  `✓ Corregido: Nafta $4.000 (antes $20.000)`.
- `summarize`: code computes the totals and returns the rendered line.
- Writes are **not** terminal. The loop continues, and the model writes the final answer. Asking a question
  is just the model's text. The person's answer comes back through the session history.

**Guards.** They must all hold. Say which eve mechanism carries each one.

1. **Owned and live.** Every id belongs to the session's user and is live. This is checked inside the
   transaction.
2. **Only ids shown.** An id must have been shown to the model in this session: the context list or a
   `find_movements` result. Track this in `defineState` and refuse in the tool's `approval` policy or in
   `execute`, with a reason the model sees.
3. **Value rules.** The current value rules apply, amounts are decimal strings, and the model does no
   arithmetic.
4. **Numbers check.** Every number in the model's final text must appear (separators normalized) in the
   person's message, the context, or a tool result of this turn. If the check fails, the text is replaced by a
   safe fallback and the failure is logged.
   - Find the hook that sees the final text before a channel sends it. If none exists, that is a finding:
     say so and propose the least bad option.
5. **What changed is code's.** Every change's code-rendered line reaches the person, even if the model's
   text leaves it out. One way is a turn hook that appends the turn's action lines.
6. **Audit.** Every tool call is recorded, as in the `action` and `tool_calls` audit today.

**Channels.**

- **HTTP channel or programmatic sessions,** for the eval driver.
- **WhatsApp through the Chat SDK adapter, locally only, against a fake Graph.** Answer:
  - Can we send the read receipt and typing indicator before the agent runs, within 1 s? Our rule: first
    signal under 1 s, never silent, an interim note at 10 s, a failure notice at 30 s.
  - How do inbound audio and images arrive?
- **MCP channel with `tools:true`.** Do our tools appear with their guards? Can user identity reach them?
  Report this; don't build auth.

**Inputs.**

- **Images.** Add one scenario with a receipt photo. Use a synthetic image you generate, with no real
  personal data. It goes through eve's attachment path to Claude vision and must log the right movement.
- **Voice.** Claude takes no audio. Report what eve or the Chat SDK do with WhatsApp audio, and the options
  for transcription. Don't add a provider. List the candidates with cost and latency.

**Eval.**

- Add about 12 scenarios to `scenarios.jsonl`: #48, #49 and `uno me quedó mal` from the live test, plus
  compound requests, questions about Warren's own actions, and indirect requests.
  - Give each one a `reply.has` where the reply content matters, for example that #49 mentions the súper and
    isn't the help text.
  - Split them between dev and test like the rest.
- Write an eve driver beside `drive.ts` that plays the same scenarios through eve and grades with the same
  `grade.ts`.
- Run both pipelines on `--split all` and record per-turn wall time for each.
- Total model budget is **US$1.50**. Tune on dev only.

## Constraints

- **Dependencies.** Ticiano approved eve for this spike. That covers `eve` plus the packages eve's docs require
  for direct Anthropic, the Postgres workflow store, and the Chat SDK WhatsApp adapter. Ask the orchestrator
  before adding any other dependency, and name it, its size and its reason.
- **Branch.** Work on `eve-spike`. Commit with `git commit -s`, ending with the trailer
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Checks.** `pnpm lint`, `pnpm typecheck` and `pnpm test` stay green. Our loop keeps working untouched beside
  eve.
- **Secrets.** They stay in `.env`. Never print them.

## Report (fill in below, then open a draft PR)

- The scores table: our loop versus eve, overall and per tag, with silent changes, invented numbers, latency
  p50 and p95 per tag, and cost.
- Each guard and the eve mechanism that carries it, or the gap.
- Findings on channels, inputs and MCP, as above.
- **Rough edges.** Bugs, missing docs, version pinning, how a session survives an eve upgrade, the checkpoint
  overhead you measured, and cold start.
- **A recommendation** against the three adoption criteria, and what adopting would take: slices and risks.
