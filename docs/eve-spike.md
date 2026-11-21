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

## Report

Run 2026-11-21, `eve` 1.3.0, `@workflow/world-postgres` 5.3.0, `claude-haiku-5-5` direct (thinking off, effort low), throwaway
local Postgres 17, fake Graph. Two `--split all` runs of each pipeline, same 111 scenarios (the original 98 plus 13 new), same
concurrency (4), same network. Reproduce: `evals/eve/README.md`. Model spend for the whole spike: about US$0.49 of the US$1.50
(tracked runs US$0.47: eve 11 runs US$0.397, loop 2 runs US$0.071; a few probes untracked, under US$0.03). Cost is token usage
priced with `src/agent/models.ts`, not an invoice.

### Summary

**Do not adopt eve as the agent loop yet.** It runs on top of the core with all six guards expressed in its own mechanisms and
no fork, and it is clearly better at inputs, own-action questions and channels. But it fails the quality criterion on the
original 98 scenarios (92/98 and 90/98 against 98/98), has one silent wrong change and one invented number across its two runs,
and its p50 is 346 ms over ours (limit 300 ms; p95 is 710 ms better). The misses are one fixable weakness, bare answers to its
own questions, plus format slips of a model that must narrate. See the recommendation.

### Scores, loop versus eve

Two runs each, shown as `run 1, run 2`. "Original 98" is what the loop scored 98/98 on; "New 13" are the 12 text scenarios from
the live failures plus a receipt photo (the loop cannot read an image, and its canned replies cannot answer "borraste el super?").
`pnpm tsx evals/eve/compare.ts 2` prints these tables from the result files.

|      | All 111          | Original 98  | New 13       | Silent changes | Invented numbers | p50 / p95 per turn (ms)  | Cost per run   |
| ---- | ---------------- | ------------ | ------------ | -------------- | ---------------- | ------------------------ | -------------- |
| Loop | 107/111, 107/111 | 98/98, 98/98 | 9/13, 9/13   | 0, 0           | 0, 0             | 1434 / 2954, 1481 / 3267 | $0.036, $0.035 |
| eve  | 104/111, 103/111 | 92/98, 90/98 | 12/13, 13/13 | 0, 1           | 1, 0             | 1814 / 2383, 1816 / 2565 | $0.050, $0.045 |

- Held-out test split (24 scenarios, counts only): loop 23/24 and 23/24, eve 21/24 and 21/24, 0 silent on both. Because the
  test split was run four times while tuning (counts only, never which scenarios), treat it as a loose check. Tuning used the dev
  split only: 5 rounds, about US$0.04 each.
- Per-turn cost: loop US$0.00026, eve US$0.00036 to 0.00039 (1.9 model calls per turn instead of 1; 98% of input tokens were
  cache reads).
- Pooled over the dev turns of both runs: loop p50 1464 / p95 3067 ms, eve p50 1810 / p95 2358 ms. Latency is post-to-reply: the
  loop's number ends at the stored reply on in-process PGlite, eve's at the fake Graph receiving the text over HTTP, so eve's
  includes one local hop the loop's does not (single-digit ms).
- The loop's four misses are the 13 new scenarios it cannot do: two "did you delete it?" questions, the photo, and one held-out.

Per tag (a scenario counts in each of its tags; passed/total for each run, then p50 / p95 ms):

| Tag            | Loop         | eve          | Loop p50 / p95           | eve p50 / p95            |
| -------------- | ------------ | ------------ | ------------------------ | ------------------------ |
| logging        | 31/32, 31/32 | 31/32, 32/32 | 1415 / 1889, 1422 / 1823 | 1848 / 2137, 1821 / 2172 |
| correction     | 47/48, 47/48 | 45/48, 45/48 | 1551 / 3131, 1608 / 3716 | 1896 / 2584, 1920 / 2701 |
| deletion       | 25/27, 25/27 | 26/27, 25/27 | 1413 / 3067, 1592 / 3512 | 1759 / 2443, 1713 / 2193 |
| answer         | 10/10, 10/10 | 6/10, 4/10   | 1586 / 4903, 1503 / 5017 | 1634 / 2137, 1679 / 2288 |
| query          | 14/14, 14/14 | 14/14, 14/14 | 1334 / 2082, 1296 / 2367 | 1724 / 1997, 1754 / 1936 |
| multi-action   | 12/12, 12/12 | 12/12, 12/12 | 1540 / 1991, 1587 / 3716 | 1933 / 2283, 1955 / 2172 |
| older-item     | 4/4, 4/4     | 4/4, 4/4     | 2520 / 2725, 3258 / 3582 | 2574 / 2822, 2597 / 2762 |
| typo           | 9/9, 9/9     | 9/9, 9/9     | 1479 / 1889, 1322 / 1604 | 1803 / 1961, 1756 / 2072 |
| time-reference | 21/21, 21/21 | 20/21, 20/21 | 1434 / 1986, 1626 / 2631 | 1941 / 2383, 1999 / 2427 |
| other          | 4/8, 4/8     | 6/8, 7/8     | 1995 / 5329, 1521 / 3229 | 1071 / 2137, 1038 / 2171 |

Where the time goes (event timestamps, `evals/eve/timeline.ts`, four turns): the first model call ends in the tool call at
0.9 to 1.2 s, the tool runs in 4 to 5 ms, and the gap from one model call settling to the next requesting is 14 to 17 ms. So
**checkpoint overhead is about 15 ms per step**; the real cost of non-terminal writes is the second model call that writes the
final text, about 0.7 s. The loop's p95 is worse on questions and older items (one slow call plus retries); eve's is steadier.

What eve got wrong in the dev runs (the test misses are not shown):

- **Bare answers to its own question** ("2", "sí", "la segunda"): the mapping from an option number back to a movement lives in
  the model, not in code. It fails intermittently, and in a tuning run it deleted the wrong movement. The loop does this in code
  (`answerAction` over stored `asked_ids`), 10/10.
- **Format slips**: with thinking off, Haiku narrates when it is unsure, sometimes in English ("I can't find a movement called
  almuerzo... ¿Cuál querés borrar?"), so the reply does not start with "¿" (the grader's question rule). The prompt asks for
  Spanish, no reasoning and a question that starts with "¿" and it still slips in some runs.
- **The one silent change**: `el 1 luca fue 1500` corrected the helado (list position 1) instead of the 1,000 peso kiosco. It is
  the same miss the loop had before slice B, and it is the failure that matters most.
- **The one invented number**: `cafe 3000` produced "$3000 / $3500" in a question. The numbers guard passed it (the digits are in
  the facts) but `grade.ts` wants exact money formats. The guard compares normalized numbers, so a wrong format passes.
- `grade.ts` reads "borre" in a question as "Borré" (accents are ignored), so s059 can fail on a harmless word.

### Guards: each one and the eve mechanism that carries it

| #   | Guard                  | eve mechanism                                                                                                                                                                                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Owned and live         | The tool's `execute`: the owner is `ctx.session.auth.current.principalId` (the channel's route auth), and `lockLive(tx, accountId, id)` runs inside the tool's own transaction.                                                     | Holds. Over MCP a caller sees only their own rows (checked with two users).                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | Only ids shown         | `defineState('warren.shown')`, filled by the dynamic context instruction and by the tools, refused in the tool's `approval` policy (`{type: 'denied', reason}`).                                                                    | Holds, with the reason visible to the model (checked: asking for an unseen id gets `TOOL_EXECUTION_DENIED` and the model asks for a description). Over MCP it fails closed: state does not persist across calls, so `correct_movement` and `delete_movement` can never pass there.                                                                                                                                                                               |
| 3   | Value rules            | `inputSchema` (zod, from `src/agent/schema.ts`; eve validates before `execute`, and turns provider strict mode off), then `checkLog` / `checkChanges` / `checkCount` in `execute`, which throw so the model reads the reason.       | Holds. Weaker than strict tools for shape (the model can send a malformed call once). The 10-per-message cap counts rows in the turn's `inbound_message`.                                                                                                                                                                                                                                                                                                        |
| 4   | Numbers check          | The WhatsApp channel's `events['turn.settled']` (and a no-op `content.completed`), which post one checked reply per turn. Facts: the person's text, the context, this turn's tool results, and earlier tool results from the audit. | **Works only per channel.** No global hook can see or change the final text: hooks run after the event is recorded and their return value is ignored; only a channel's own handler decides what is sent. The HTTP channel (`reply` in the result) and MCP get no check. Every channel needs the same handler. It replaced the model's text on 1 to 3 turns per run. Least bad option: one `finalize()` shared by every channel (done) and no channel without it. |
| 5   | What changed is code's | Same handler: the lines come from `calls(ctx.view, {turnId})` outputs and `finalize()` appends the ones the model left out (and drops a copy it already made).                                                                      | Holds, channel-bound like 4.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | Audit                  | A global hook on `call.settled` writes every call to `inbound_message.tool_calls` (a denied call too, which the tool never saw); `usage.recorded` writes tokens.                                                                    | Holds for calls. Not done: `action`, `model_ms`, `reply_text` (a `turn.settled` hook could).                                                                                                                                                                                                                                                                                                                                                                     |

Gaps against the core's own rules (`AGENTS.md`), none of them a guard in the brief:

- **No commit point.** Rule 2 says writes are validated and run in one transaction with the reply. In eve each write is its own
  transaction, the tool calls of a step run in parallel, and nothing rolls back the first if the second fails. The parallel race
  was real (two writes took the same `position`) and is fixed with `pg_advisory_xact_lock(inboundId)` per turn; a failed second
  action still leaves the first applied, and the model then says so.
- **No at-most-once on a replayed step.** eve says a step interrupted after a call started does not rerun that call, and a call
  whose start was not saved can. Our write tools have no idempotency key (`ctx.callId` as a unique key would be the fix).
- **No deadline, no interim note.** There is no turn timeout or step cap, only a session usage limit. A 10 s interim note would
  need `ctx.waitUntil` on `turn.started`, which holds the step open until it settles (up to 30 s), so it would delay the turn.
  Not built. A failure is covered: a model error ended the turn in 0.56 s and the channel posted our notice (after overriding
  the default `session.ended` handler, which posts eve's English "session could not recover" with an error id).
- **Rule 2** (the model never writes a reply) is bent as the brief intends; the model never picks a target in code's place is
  kept by guards 1 and 2, but a wrong pick among shown ids still happens (the silent change above).

### Channels, inputs and MCP

- **WhatsApp (Chat SDK, fake Graph).** Works, locally only. First signal: the adapter's `startTyping` is one Graph call that
  marks read and shows typing, and eve's default `turn.started` handler makes it. Measured webhook to that call: p50 34 ms, p95
  47 to 87 ms over 128 turns, so the under-1 s rule holds when warm. **Cold, the first webhook after boot waited about 1.5 s**
  (lazy Chat SDK start); a warm-up request at startup would be needed. `call.requested` sends another typing call per tool call.
  The in-memory state adapter keeps subscriptions only in the process; after a restart a DM arrives as a new thread through `onNewMention` and still worked in my restart checks. The adapter
  needs a numeric phone number id and refuses to download media from a loopback host (SSRF guard), so media cannot be faked
  locally.
- **Images.** Work through eve's attachment path (a file part, staged in a sandbox, sent to Claude vision), checked on the HTTP
  channel with a synthetic receipt (`evals/scenarios/fixtures`). First try it itemized the ticket; one prompt line (log the
  printed total, never add items) fixed it, and s111 passes. Costs: eve sends the image again on every later call of the
  session, and **attachments need a sandbox** (Docker here; the build must reach Docker, and the sandbox runs only for sessions
  with attachments). Railway cannot run Docker-in-Docker, so production would need Vercel Sandbox, another provider, or a
  channel that fetches media itself. The WhatsApp media download itself is untested (needs a real public host).
- **Voice.** Claude takes no audio. A WhatsApp voice note is an `audio` attachment; eve passes audio as a file label, not as
  sound, and its docs' pattern is a `transcribe_audio` tool that reads the file from the sandbox. Tested with a fake note: the
  model said it could not listen and asked for text. Candidates for a transcription tool, from vendor-quote pages read on
  2026-11-21 (third-party aggregators, unverified): Groq `whisper-large-v3-turbo` about US$0.0007/min, 1 to 2.5 s; Deepgram
  Nova-3 US$0.0043/min, 0.8 to 1.9 s; OpenAI `gpt-transcribe` US$0.0045/min, about 2.3 s (`whisper-1`, the docs' example, and
  `gpt-4o-transcribe` are deprecated, shutdown 2027-02-26); ElevenLabs Scribe v2 about US$0.004/min, 2.5 to 3.1 s, best quality
  on their benchmark. A voice turn adds the download, the transcription and a second model path, so budget 2 to 4 s on top.
- **MCP channel (`tools: true`).** The five tools appear with their schemas, run with no model and no turn, and run as the
  authenticated caller, so identity reaches them (`principalId`, checked with two users) and owner isolation holds. The guards
  that live in `execute` and `approval` apply (guard 2 denies, value rules apply). Limits: state is empty on every call, so
  id-based writes are unreachable; there is no numbers check or lines (no model, so none needed); `agent_start` runs the agent
  as a durable task (per the docs; not exercised). Auth is a stand-in; real OAuth would be the next piece.

### Rough edges

- **Version pinning and policy.** eve 1.3.0 and `@workflow/world-postgres` are under the repo's 3-day `minimumReleaseAge`:
  `eve` is excluded by name (exact pin), the world is pinned to 5.3.0 (5.4.x is too young; eve needs 5.1.1 or later). `ai` (peer,
  not optional) came in by pnpm's auto-install. `graphile-worker` pulls `@types/node@22`, whose `undici-types@6.21.0` trips
  `trustPolicy`; a one-line override to the version the repo already uses avoids widening the policy. `cbor-extract`'s optional
  native build is declared `false`. About 170 packages were added.
- **Upgrades.** On the Postgres world a session built by another eve version is stranded: it keeps its address, runs nothing,
  and ends on the next message with a fresh session (history readable via `sessions.attach`). Pin the exact version and plan the
  upgrade as a session reset; the ledger is ours, so only chat context is lost. Same-version rebuilds and restarts resume:
  checked (a session continued across a restart with its history).
- **Cold start.** `eve start` is healthy in about 1.5 s; the first webhook then needs another 1.5 s for its first signal
  (above). Warm turns are the numbers above; the first turn after boot was about 3 s.
- **Checkpoint overhead.** About 15 ms per step, measured above; compaction (threshold 0.9) and the per-session workflow run
  handoff exist for long sessions but were not reached.
- **Context growth.** The per-turn context is a user-role dynamic instruction; it joins the history whenever its text changes
  (every turn, since the clock changes), so history grows about 1.5 KB per turn and is never rewritten. A session is long-lived
  (default timeout 30 days) where the loop used a 30-minute window; compaction handles size, but the cost per turn grows.
- **Prompt cache and provider options.** Both pass through: `modelOptions.providerOptions.anthropic` (`effort`, `thinking`) and
  automatic cache breakpoints on the system prompt and the last block (98% of input tokens read from cache). `reasoning: 'none'`
  sends no `thinking` field at all, so thinking was not disabled until set explicitly in `providerOptions`. I confirmed the
  request body with a local fetch capture (debug only, not in the repo). Tools are sent with strict mode off.
- **Docs.** They are bundled and version-matched in `node_modules/eve/docs`, which is the right place to read. Gaps: no turn
  deadline or step cap is documented; the Chat SDK page does not mention the SSRF guard or the numeric phone id; the Anthropic
  helper's default is `claude-sonnet-5`; the default `session.ended` message to WhatsApp users is English with an error id.
- **Docker sandboxes.** Containers stay after a run (40 were left by my photo and voice probes; removed).

### Memory and reminders (design only)

- **Memory (slice F).** eve's memory slots (a file provider, Supermemory, or a custom provider with recall, capture and tools)
  scope per caller, but our facts ("la visa es la del Galicia") must be shown in context and edited by tools with a table the
  core owns, so the straightforward fit is a `facts` table in the core plus two tools and a line in the context instruction.
  eve's memory would duplicate it.
- **Reminders (slice G).** `defineSchedule` (cron) plus `ctx.to(whatsappChannel, thread).send(...)` starts a proactive session.
  The WhatsApp 24-hour window and template messages are not in the Chat SDK adapter's surface that I read; that, not eve,
  is the design question.

### Recommendation

Against the three criteria:

1. **Quality: fails.** On the original 98: eve 92 and 90 against 98 and 98 (limit: about 2). On all 111: 104 and 103 against 107.
   One silent wrong change and one invented number across two runs (limit: 0 and 0). eve is better where the loop is weakest
   (12 or 13 of the 13 new scenarios against 9), so the gap is real in both directions.
2. **Speed: marginal.** p50 +346 ms pooled (+380 and +335 per run), limit +300; p95 710 ms better, limit +600 worse. The
   second model call for the final text is the cost. A terminal `say` tool with `endsTurn: true` would remove it (about 0.7 s)
   but gives up the "model sees the result, then writes" shape; not tried.
3. **Guards: pass, with caveats.** All six work through eve's own mechanisms with no fork and no patch. Two (4, 5) are
   channel-bound, and the commit point, at-most-once and deadline of the core have no eve equivalent.

What adopting would take, as slices, each with its own proof (`pnpm tsx evals/eve/run.ts --split all` against the loop's
98/98 and the new 13):

- **E1. Bare answers in code.** In the WhatsApp channel, before `send`, run the loop's `answerAction` on a stored question (the
  model's question would have to be a tool that stores `asked_ids`, or the channel parses its numbered options). Target: the
  `answer` tag 10/10 and 0 silent changes. Risk: it re-adds `asked_ids` machinery next to eve.
- **E2. Writes safe to replay.** `ctx.callId` as an idempotency key on the write tools; report partial multi-action results.
- **E3. Deadline and first signal on cold start.** A boot warm-up, and a channel-level timer for the interim note and the 30 s
  failure notice (eve has no mechanism; this is custom code outside the workflow).
- **E4. Media.** A sandbox provider that runs on Railway, or a media fetch in the channel, then the transcription tool.
- **E5. Format hardening.** Either stricter numbers (exact money format) or a terminal `say` tool; and decide the English-leak
  policy (a language check in `finalize`).
- **E6. Production.** `eve start` behind the same Railway service (Nitro, `/eve/` and `/.well-known/workflow/` routes), Postgres
  world in the existing database, pinned eve, one process.

Recommended path: keep the loop as the shipped agent. Re-run this driver after E1, E2 and E5 (about one to two days); if the
original 98 are within 2 and silent and invented are 0 in three runs, adopt eve for new channels, images and MCP, with the loop's
core untouched. If the goal is only more channels and voice soon, a thinner option is the loop plus the Chat SDK adapter alone,
without eve's workflow runtime.
