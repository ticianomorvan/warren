# Warren rebuild: one clean foundation

Status: draft for Ticiano's read, 2026-11-22. This file is the source of truth for the build. A fresh session builds from it alone.

The evidence behind it:
- two councils, each with an Opus 5.5 and a Fable 5.2 judge per group, on 3 groups each;
- four Sonnet research briefs;
- five Opus area reviews.

Their full outputs are in `docs/rebuild/` (added in R0): `council-core.json`, `council-agent.json`, `briefs/`, `reviews/`.

## Goal

Rebuild Warren on main, in place, as if written today with everything we learned. Behaviour stays the same, except where a decision below changes it. We end up with:
- one migration set with no superseded steps;
- one record per unit of work, for every channel;
- one write path, one undo engine and one tool registry;
- replies rendered by code;
- a test pyramid that runs the race tests in CI;
- a staging environment that proves the whole product with no person in the loop.

Done means:
- **Checks:** `pnpm check` (lint, typecheck, PGlite tests) and the real-Postgres CI job pass.
- **Scenario eval,** 3 runs of all splits:
  - ≥95% fully right;
  - 0 silent wrong changes;
  - 0 invented numbers;
  - p50 model turns no worse than the main baseline, which is taken first.
- **Staging probe:** the `pnpm probe staging` script passes. It sends signed WhatsApp webhooks that Graph calls answer through a sink, makes MCP calls, and lets a reminder fire.
- **Cutover:** live data is imported and verified (the counts and sums match), production probes pass, and the old database is kept for rollback.
- **Ticiano** sends one WhatsApp message and one Claude message after cutover. That is the only manual step, and it comes at the end.

## Not doing

- **Product features:**
  - budgets, PDFs and card statements;
  - other channels (Telegram, ChatGPT);
  - per-client MCP revocation;
  - erasing a forgotten fact's value.
- **Reply wording polish.** Wording changes only where a decision below says so.
- **Swaps of settled choices:** no agent framework, no Drizzle, no queue library, no hosted auth, and the agent model stays Haiku 5.5.
- **Relative movement dates resolved by code.** No failure has been measured; the scenarios check this.
- **Parallel `find_movements`.** In 0 of 1,300 stored turns did the model send two searches.

## What exists (main, 066eb87)

About 15k lines of src, 17k of tests and 15 migrations.

**Carried over largely as they are** (proven, pure or measured):
- `reminders/schedule.ts` (nextOccurrence, normalizeSchedule);
- `range.ts`'s resolution core;
- `summary.ts` (bigint cents);
- `render-summary.ts`;
- `transcribe.ts` (the Whisper confidence gate);
- `whatsapp/graph.ts` (limits, allowlist, 131030 fallback);
- `validate.ts` rules;
- `memory.ts` secret and contact rules;
- the number primitives in `say.ts`;
- `fitReply`;
- `redact.ts`;
- the better-auth config, plugin and link flow;
- `auth/pages.ts`;
- the MCP door checks;
- the scenario eval harness and its 214 scenarios;
- `latency-report.ts`.

**Rewritten:**
- `process.ts`, `store.ts`, `ledger.ts`, `apply.ts`, `execute.ts`;
- the `undo*.ts` files, `facts.ts`, `reminders/db.ts`;
- `agent/loop.ts`, `calls.ts`, `say.ts`, `prompt.ts`, `schema.ts`, `tools.ts`;
- `mcp/write*.ts` and `mcp/tools.ts`;
- the test harness.

## Design

**Layout.** No Channel interface until a second chat channel exists.

```
src/
  core/      db.ts, schema (001_init.sql, 002_auth.sql), turn.ts, history.ts (versions + undo engine),
             apply.ts, commands.ts (registry), guards.ts, describe.ts, es.ts, numbers.ts, secrets.ts, values.ts
  domain/    movements.ts, facts.ts, reminders/{schedule,describe,send,db}.ts, range.ts, summary.ts
  agent/     understand.ts, context.ts, prompt.ts, examples.ts, loop.ts, reply.ts, models.ts
  whatsapp/  ingest.ts, payload.ts, worker.ts, send.ts, media.ts, graph.ts, transcribe.ts, resolve.ts
  mcp/       endpoint.ts, door.ts, tools.ts, clients.ts
  auth/      config.ts, plugin.ts, link.ts, routes.ts, pages.ts, disconnect.ts
  app.ts, server.ts, warren.ts (createWarren(deps): the one wiring, used by server, tests, eval)
test/        kit (useDatabase reads PG_TEST_URL, schema per file), fakes (Graph, Anthropic typed to SDK Message)
evals/scenarios/ (single-message eval deleted after its uncovered cases are ported)
scripts/     probe.ts, import-v1.ts, cutover.ts, graph-sink/ (staging only)
```

### 1. Data (council 1, decisions D0–D16)

- **Accounts and addresses:**
  - `account(id, created_at, mcp_revoked_at)`.
  - `account_address(account_id, channel, address)`, UNIQUE on `(channel, address)`. `wa_id` lives here only.
- **`turn`**, the committed unit of work. It is inserted only in the commit transaction, so its existence is the commit point.
  - Columns: `account_id`, `channel` (whatsapp | mcp | cli), `created_at`, `label`, `calls jsonb`, `record`, `reply`, `question jsonb {options:[{n,id}], then}`, `undoes`.
  - `undoes` is UNIQUE where set, with `CHECK (undoes <> id)`.
  - Undo order is commit order (turn id).
- **`mcp_request`**:
  - Columns: `account_id`, `request_id`, `input_hash`, `turn_id`, `result jsonb`, `created_at`.
  - Primary key: `(account_id, request_id)`.
- **`wa_message`**, WhatsApp transport only:
  - **Identity:** `wamid` UNIQUE, `wa_id`, `kind`, `text`, `media_id`, `meta_ts`, `received_at`, and `context_wamid` (the message being replied to).
  - **Queue and send state:** `status`, `attempts`, `claimed_at`, then the send markers `typing_sent_at`, `interim_sent_at`, `failure_sent_at`, `send_started_at` and `reply_sent_at`.
  - **Trace:** `turn_id` UNIQUE, `audit` and `timings`.
  - It stores no raw payload text.
  - The `reply(outbound_wamid, status…)` and `reminder_send` tables stay as status sinks.
- **Versioned stores.** `movement`, `fact` and `reminder` all share the same history columns:
  - `entity_id` (stable across versions), `made_in` (references turn), `ended_in` (references turn), `ended_at`;
  - a CHECK on the `ended_*` pair, and `UNIQUE (entity_id) WHERE ended_at IS NULL`;
  - live means `ended_at IS NULL`.

  Store-specific details:
  - **fact:** UNIQUE `(account_id, kind, key)` where live.
  - **reminder:** it keeps `next_due_at` as declared mutable scheduler state. It has no `sent_count` (`reminder_send` counts).
  - **movement:** it has no `position`. It adds `amount CHECK (scale(amount) <= 2)` (verify PGlite supports `scale()`) and a generated, accent-folded `search` column.
- **Ids.** The model and MCP see `entity_id`, which stays the same across corrections.
- **Locking.** Every write transaction takes one account lock first: `SELECT 1 FROM account WHERE id=$1 FOR NO KEY UPDATE`. There are no advisory locks except 7203001 for migrations and 7203004 for sign-in. The reminder sweep keeps `SKIP LOCKED` row locks.
- **Append-only.** It covers the person's data. Only `ended_*` and `next_due_at` change in place. A plpgsql trigger enforces it if PGlite ships plpgsql; otherwise a test invariant does.

### 2. Core

- **`commands.ts`**, a registry that holds data only. Each tool's entry has:
  - `input` (zod: real optionals and discriminated unions, no sentinels, no `text`, `.describe()` on fields);
  - `description`;
  - `kind` (read | write | answer | ask);
  - `effect?`, `label` and `alone?`;
  - `examples` (typed, parsed by a test);
  - `mcp? {title, description, scope, output, extra}`.

  Everything else derives from it: the agent `TOOLS`, the MCP tools, the labels and the prompt's tool list. Guards, apply and describe stay exhaustive switches over the unions, each checked with `satisfies Record<Tool,…>`.
- **`guards.ts`**:
  - `checkValues(tool, input, {today, now})` is shared by MCP and WhatsApp.
  - `checkTurn(calls, shown, message)` holds the conversation rules: ids shown, facts in the person's words, alone tools.
  - Code declines are typed (`{declined: 'secret'|'contact'|'reminder_past'|'reminder_far'}`), so redaction keys on the code, not on reply text.
  - `values.ts`, `secrets.ts` and `numbers.ts` are pure and live outside `agent/`.
- **`apply.ts`**: `applyCall(tx, {accountId, turnId, now}, call) → Outcome`. It covers all nine writes:
  - log, correct and delete movements;
  - undo;
  - remember and forget a fact, and forget all;
  - set and cancel a reminder.

  `Outcome = {tool, status (one closed union), effect, …data}`, and the rows come from `RETURNING`.
- **`history.ts`**, one undo engine:
  - effects are derived from versions (`made_in` and `ended_in` grouped by entity);
  - an effect is stale when the live version is not the one the turn left;
  - store hooks hold the reminder rules: a one-off already sent, no occurrence left, the cap and `next_due_at`. The cap also applies to facts.
  - **Strict stack (Ticiano):** a change that can never be undone blocks older ones. The reply says why and points to fixing the older change directly.
  - Policy is passed in as `stores`. MCP may undo every store once it has reminder tools.
- **`describe.ts`**: one Spanish `describe(outcome, {today, newest})` for both channels. MCP wraps it in structured output.
- **`es.ts`**:
  - months, weekdays and `list()`;
  - `money` and `clock`;
  - one short date format (`05/12`, plus `/25` outside the current year);
  - category labels.

### 3. Agent (council 2)

- **Kept:**
  - the loop: manual, up to 3 turns, terminal tools, nothing written before the commit, held writes, and a turn runs whole or not at all;
  - the frozen 1h-cached prefix;
  - thinking disabled at effort low;
  - non-strict tools;
  - context as the first user turn.
- **Replies:**
  - code renders every record, total, question and refusal;
  - free text only in `reply` (alone, with the numbers check and the claims check);
  - a typed `skip {part, reason}` covers parts not done, and code renders it;
  - `text` is removed from the 13 action tools. In stored runs only 7% of action calls used it, and most of those were restatements.
  - Deleted: `restates`, `FILLER`, `echoes`, `Applied`, `amountsOf`, `textFlaws`, the repair turn, `cleanQuestion` and `hasValue`.
- **`ask_user`** becomes `{movement_ids, then: delete | correct{changes} | ask_change}`, with no free `question`.
- **`summarize`** takes a typed `Range` (named, month, year, dates) and `compare: previous | Range`. `parseOther`, `stray` and `empty` are deleted.
- **`set_reminder`** takes `first: {in:{n,unit}} | {day: today|tomorrow|day_after, time?} | {weekday, time?} | {month_day, month?, time?} | {date, time?}` plus the repeat fields. A pure `resolveFirst` does the clock arithmetic. No word check reads the message ("hoy").
- **Context** (`context.ts`):
  - **One `Shown` value** feeds the context text, the ids the guards accept and the numbers evidence.
  - **The conversation window** comes from `turn` across channels, plus reminder sends. Claude's writes and "⏰ Recordatorio: …" are visible, so "cancelá este" works.
  - **Descriptions are clipped** and escaped.
- **Prompt:**
  - the policy prose stays hand-written, one place per rule;
  - the tool list and limits are interpolated from the registry;
  - examples are typed data rendered into the prompt;
  - the duplicate `# Tools` bullets are deleted;
  - token counts are measured before and after.
- **Model and loop details:**
  - the `sonnet` model key is deleted;
  - `stop_reason: 'refusal'` gets the failure notice, an audit entry with the category, and no retry (this is a bug today);
  - the warm-up uses `max_tokens: 0`;
  - usage is summed from the turn log;
  - each call gets a timeout inside the deadline.
- **Measured, adopted only if the eval holds:**
  - **(a) `tool_choice: {type:'any'}` on Haiku.** One judge warns that it removes the model's only reasoning when thinking is off.
  - **(b) Pre-search.** Older live movements whose words or amount appear in the message are added to the context (at most 8), so the model still picks the id. This is retrieval, like facts today. Adopt it only if second turns drop by at least half on a new long-ledger scenario set, with 0 silent wrong changes.
  - Targeting by "match" resolved by code was **rejected** for writes: a single wrong hit is a silent wrong change.

### 4. WhatsApp channel (council 1 D11–D13, reviewer A)

- **Ordering:**
  - the claim takes a sender's oldest due row inside that sender's lane, and only when no older open, uncommitted, not-stale row exists;
  - `kick(senders)` claims by sender;
  - the sweep runs senders in parallel, and housekeeping runs in the sweep only.
- **Speed:** the first signal is sent on receipt, not after waiting for the lane (measure p95 on bursts).
- **Media:** `payload.ts` parses audio too, and `media_id` is stored at ingest.
- **Code answers:** `resolve.codeAnswer(text, {question, typed, signIn})` is one pure function.
- **Kept:**
  - stamp-then-send (only a 4xx proves nothing was sent);
  - the owner guards;
  - the abort and deadline race;
  - the interim note and the deadline.

### 5. MCP and auth (reviewer D)

- **Kept:** better-auth, its plugins and Kysely (the MCP SDK only checks tokens; it does not issue them).
- **Registration:** `app.ts` mounts three things: the webhook, the authorization server and `/mcp`.
- **Clients:** `clients.ts` lists each allowed client's hosts, name and origins. This is the groundwork for adding more clients.
- **`/mcp` handler:** `toNodeHandler({fetch: door then handler})` with the SDK's `originValidationResponse`. `auth/http.ts` and the `req.auth` mutation are deleted.
- **Tools** come from the registry, reminders included, and use the canonical schemas plus `request_id`, `limit` and `cursor`.
- **Access:** `isAllowed` moves into an account access module.
- **Disconnect:** `disconnect.ts` deletes through the adapter, or a pinning test covers its LIKE.

### 6. Tests, evals, tooling (reviewer E)

- **Layers:** pure tables, then contract tests on the database (`apply`, `history`, `turn`), one thin test per channel path, race tests on real Postgres, and scenarios end to end.
- **CI:** a `postgres:17` service job runs the whole suite. A boot test checks `/health` through `createWarren`.
- **Flakes and speed:**
  - `until()` replaces fixed sleeps;
  - MCP tests mint tokens with `forge`;
  - property tests collect their failures and assert once.
- **Deleted:** the single-message eval (after porting its uncovered cases) and `cache-probe.ts`.
- **Scenario eval:**
  - `--repeat k` measures flaky scenarios;
  - a generated `results/latest.md` replaces `baseline.md` and the prose result tables.
- **Kept:** `tsx`.
- **Docs:** `AGENTS.md` is rewritten, `CLAUDE.local.md` is updated, and the old specs move to `docs/history/`.

### 7. Ops

- **Railway as code** (`.railway/railway.ts`):
  - draining about 15 s and an overlap setting (verify both in Railway's docs);
  - a `staging` environment with its own service and Postgres;
  - `GRAPH_BASE_URL` pointing at a tiny `graph-sink` service that records sends.
- **`scripts/probe.ts`** runs the scenarios below:

  | Path | What it checks |
  |---|---|
  | Signed webhooks (log, correct, undo, question then answer, voice and photo fixtures, a reminder in 1 minute) | the sink's sends and the database state |
  | MCP: 401 and metadata | the unauthenticated challenge |
  | MCP: read, write, then WhatsApp undo | an MCP token minted from staging's JWKS |
  | Reminder | it fires once |

  The same script, read-only, runs against production.
- **Cutover** (`scripts/cutover.ts`), each step logged:
  1. `pg_dump` the old database.
  2. Create the new Postgres and run the migrations.
  3. Run `import-v1.ts`, which builds entities, versions and turns from v1 rows. History before the cutover becomes single versions. Batches older than the cutover can't be undone.
  4. Verify: every account, live movement count and sum per currency, the live facts and the live reminders with their `next_due_at` match.
  5. Point `DATABASE_URL` at the new database and deploy.
  6. Run the production probes.

  **Rollback** means pointing back to the old database and deploying the tag `v1-final`.

## Slices

All of them land on branch `rebuild`, in one PR, built by sequential Sonnet 5.5 builders. Each slice ends green on its own proof.

| # | Slice | Proof |
|---|---|---|
| R0 | Baseline and scaffold: run the scenario eval 3× on main and store it. Tag `v1-final`. Commit the council and review outputs to `docs/rebuild/`. New layout, `createWarren`, test kit, real-Postgres CI job, `pnpm check`. | CI green on an empty core; baseline numbers in `results/latest.md` |
| R1 | Schema `001_init.sql` and `002_auth.sql`, the append-only guard, `migrations.test` | migrations test on PGlite and on Postgres |
| R2 | Core: registry, guards, applyCall, history and undo engine, turn, describe, es | contract tests ported from `undo`, `memory`, `reminder-agent` and `words` and passing; golden test of v1 reply strings, byte-identical except the date format |
| R3 | Agent: understand, context, prompt, examples, loop, reply and skip, typed tools | unit tests; scenario eval 3× all splits at the bars; token count logged |
| R4 | WhatsApp worker, ingest, send, media, codeAnswer | channel tests; concurrency tests on real Postgres including the deploy hand-off order |
| R5 | Reminders sender on the new schema | the slice 6.1 send tests ported |
| R6 | MCP and auth on the registry, `mcp_request`, reminder tools | end-to-end OAuth and MCP test; MCP write then WhatsApp undo |
| R7 | Measured experiments: `tool_choice any`, pre-search, first signal on receipt | each adopted or reverted on eval and latency numbers, recorded in the PR |
| R8 | Ops: Railway environments, graph-sink, probe, import, cutover scripts | `pnpm probe staging` green; import verification on a copy of production |
| R9 | Fresh-context Opus review (`/code-review` high and `review-design`), fixes, then cutover and production probes | review findings answered; production probe green; Ticiano's live check |

## Decisions (Ticiano, 2026-11-22)

1. Rebuild from scratch on main, autonomously, with no manual testing in the middle.
2. Undo keeps the strict stack, and the reply explains a block.
3. BAJA is removed, and cancelling goes through the agent (already shipped in #53).

## Open questions

1. **Template name.** Meta keeps refusing `warren_reminder` while it is "being deleted", and may block reusing the name for weeks (unconfirmed). Shall I submit `warren_reminder_v2` (same text, UTILITY, es_AR) now, so approval runs during the rebuild?
2. **Spend.**
   - Evals: about 25 scenario runs at about US$0.11 each, plus experiments, so I ask for a cap of **US$5**.
   - Railway: a staging environment (one service and one Postgres) for the length of the rebuild, deleted after cutover.

   Both fine?
