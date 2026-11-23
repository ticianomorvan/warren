# Warren rebuild: one clean foundation

Status: approved by Ticiano, 2026-11-22. This file is the source of truth for the build. A fresh session builds from it alone.

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

### As built (R0)

- **Baseline:** tag `v1-final` (066eb87) pushed. Three runs of `pnpm eval:scenarios --split all` on it, US$0.338 in all. Their summaries are committed as `evals/scenarios/results/v1-baseline.json`; `pnpm eval:report` writes `results/latest.md` from run files and always renders that baseline as its own section, so no slice re-runs v1. Until R3 the "Latest" section shows the same three v1 runs. The bar to match: median 213/214 fully right, 0 silent, 0 unnecessary, 0 invented, per-turn p50 1,192 ms and p95 1,831 ms, p50 model turns 1 (3.1% of messages need a second).
- **p50 model turns is derived:** the held-out turns are stripped from result files, so the report reads it from the second-turn share (1 while under half of the messages need a second turn). A slice whose share passes 50% reports 2.
- **Test kit:** `test/db.ts` (`useDatabase({max?})`: its own schema per file on `PG_TEST_URL`, dropped after; PGlite otherwise), `test/until.ts`, `test/fakes.ts` (Graph, transcriber, Anthropic client returning a real `Message`, via `message()` and `toolUse()`). `src/test-harness.ts` keeps `setup` and the webhook helpers and re-exports the kit, so v1 tests did not change; the slices that rewrite them move to `test/` imports. Fixed 150 ms `settle()` sleeps (26 calls) were not converted: `until` is there for the rewritten tests.
- **Real Postgres:** the whole v1 suite passes on `postgres:17` (1235 tests, none skipped; the 14 that PGlite skips run there). No v1 test needed a skip.
- **Layout:** moved with `git mv`: `db.ts` to `src/core/`, `range.ts` and `summary.ts` (and their tests) to `src/domain/`. The other folders (`agent`, `whatsapp`, `mcp`, `auth`) already exist. `src/warren.ts` `createWarren(deps)` wires store, processor, reminder sender, OAuth routes and app; `server.ts` and the test `setup` use it. The scenario eval still builds its pipeline through `setup`, so it uses it too.
- **CI:** `check` job runs `pnpm check`; a `postgres` job runs `pnpm test` with `PG_TEST_URL` on a `postgres:17` service. `test/boot.test.ts` starts the app through `createWarren` and checks `/health`.
- **biome** ignores `docs/rebuild/` and `docs/rebuild-spec.md` (generated outputs and the spec).

### As built (R1)

- **Files:** `src/core/schema/001_init.sql` and `002_auth.sql`; `test/migrations.test.ts`. The runner is v1's: `migrate(sql, dir = legacy)` in `src/core/db.ts` (same `schema_migration` table and advisory lock 7203001); `schemaDir` is the new folder. `createTestDatabase({migrations})` takes `schemaDir` or `false` (an empty database). Nothing in the app uses the new schema yet; `useDatabase` still migrates v1. The slice that switches the app over passes `schemaDir` there and deletes `src/migrations/`, `src/migrations.test.ts` and the v1 branch of `migrate`.
- **Checked:** PGlite 0.5.16 is PostgreSQL 18.6 and ships plpgsql, so the append-only trigger runs on both (migrations.test asserts it on PGlite and on `postgres:17`). `scale(amount) <= 2` works on both. `jsonb - text[]` works on both.
- **Trigger is AFTER ROW, not BEFORE:** in a BEFORE trigger the stored generated column `movement.search` is not computed in NEW, so every update looked changed. Raising in an AFTER trigger aborts the statement the same. One function, `append_only(allowed columns...)`: no DELETE, an UPDATE may touch only the listed columns, and `ended_in`/`ended_at` cannot change once set. It guards `turn` and `mcp_request` (nothing may change), `movement` and `fact` (the ended pair) and `reminder` (the ended pair and `next_due_at`). A FK from a child row fires first on a DELETE of a referenced turn, so that error is the FK's.
- **`search`:** `lower(translate(description || ' ' || replace(category,'_',' '), 'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN'))`, exactly v1's fold, immutable, `GENERATED ... STORED`. `payment` has no folded column: v1 folds it at query time and the next slice may keep doing so. No index on `search` (v1 had none; `LIKE '%w%'`).
- **Entity ids** come from one sequence per store (`movement_entity_seq` etc., `OWNED BY` the column): the first version takes the default, a new version passes `entity_id` explicitly. `logged_at` is when the entity was first logged (a correction passes it in its INSERT).
- **`reminder_send`** is keyed by `reminder_entity_id` (no FK: it is not unique in `reminder`) and gained `account_id` so the daily cap counts a person's sends without a join. `UNIQUE (reminder_entity_id, due_at)` is the at-most-once guard.
- **`wa_message`:** the v1 `body` is `text` (also a voice note's transcript), `payload`/`updated_at`/`command`/`parsed`/`action`/`model_turns`/`model_ms` are gone (`label` is on `turn`; turns and model time live in `audit`/`timings`); `error` stays. `reply.inbound_id` is `wa_message_id`. `mcp_request.turn_id` is NOT NULL: a call that changed nothing leaves no row, as in v1.
- **`002_auth.sql`** is v1's `012_auth.sql` (better-auth 1.7.26 plus jwt, mcp and cimd, unchanged; `getMigrations(...)` reports nothing missing, asserted in `migrations.test`) with `link_request` and a comment on each table. `account.id` stays `bigserial`; `account_address` replaces `account.wa_id` (primary key `(channel, address)`, channel only `whatsapp` for now).
- **Open:** the v1 real-Postgres race test `concurrency.test.ts > facts > an undo racing a forget` failed in 1 of 3 full runs here (passed on rerun); it is v1 code the rebuild replaces.

### As built (R2)

- **What exists** (a library on the new schema; nothing in the app uses it, v1 runs on its own schema):
  - `src/core/`: `commands.ts` (registry, `TOOLS`, `labelOf`), `guards.ts` (`checkValues`, `checkTurn`, `Declined`), `apply.ts` (`applyCall`, `Outcome`, `STATUSES`), `history.ts` (`undoLast`, `lastTurn`), `turn.ts` (`commit`, `lockAccount`), `describe.ts`, `es.ts`, `numbers.ts`, `secrets.ts`, `values.ts`.
  - `src/domain/`: `movements.ts`, `facts.ts` (rules and store), `reminders/{db,describe,guard,schedule}.ts`; `range.ts` gained `planRange` for the typed `summarize` range.
  - `test/core.ts` (the kit of the core tests), `test/golden-cases.ts`, `test/golden/v1-replies.json`.
- **`made_in` and `ended_in` are `DEFERRABLE INITIALLY DEFERRED`** (edited in `001_init.sql`): `applyCall` needs the turn's id before the row exists (the spec's order: lock, writes, turn row last). `commit` reserves the id with `nextval` *after* the account lock, so turn ids of one account are in commit order. A transaction that never inserts its turn cannot commit a version (tested).
- **`commit(sql, input)`** takes `calls` (any tool: the writes are applied, the rest are carried), `compose(done, record) -> {reply, question}`, and the hooks `before(tx)` (the WhatsApp claim's guard row; false writes nothing; it runs before the account lock) and `after(tx, turn)` (the `wa_message.turn_id`, an MCP request's row). `turn.created_at` and every new entity's `logged_at` are the message's time (`now`), not the database clock, so the undo window is deterministic. `record` is the lines of the writes that changed something, or null.
- **`Outcome`** is `{tool, status, effect, ...data}`. `STATUSES`: `applied unchanged gone full past nothing expired restricted stale blocked`. `restricted` is v1's `whatsapp_only` (a store the channel's `stores` policy does not allow; it renders as "nothing to undo"). `blocked` is new (Q1): a change that can never be undone (a one-off already sent, no occurrence left, the cap) blocks the older ones; it names the change and says to fix the older one directly. That reply is new wording, so it is not in the golden test; every other undo reply is v1's.
- **History** reads effects from versions: per entity, `pre` (ended in the turn) and `post` (made in it). A turn's own intermediate versions are ignored (a value replaced and forgotten in one message restores the first). `stale` is "the entity is not as the turn left it", where versions made by an undone turn or by an undo do not count. `lastTurn` skips turns that did nothing and turns that made and ended the same thing. The stores' rules (`rules()` per adapter) are where the reminder and facts-cap rules live.
- **A pitfall found**: `SELECT entity_id AS id, id AS version ... ORDER BY id` orders by the *entity* id (an output name wins over a column). Every such query orders by the qualified column (`movement.id`). A test with three versions of one entity in one turn pins it.
- **`ask_user` and `skip`** are registry tools; `askLine`, `skipLine`, `describeFacts`, `describeReminders`, `forgetAllQuestion` and `declineLine` render what code says that is not a write. A single-option `ask_user` with a change that answers the pending question becomes `correct_movement` in `checkTurn` (v1's rewrite, keyed on `Shown.sole`).
- **Left for R3**: `context.ts` (`Shown` is the shape `checkTurn` takes), `run-summary` and the summary SQL (`queryTotals`/`queryGroups` still live in v1's `ledger.ts`), the typed-range consumers (v1's `parseOther`/`stray` stay until the agent slice deletes them; `planRange` is the typed entry), `reply`'s numbers-and-claims check (`say.ts` stays; the pure number primitives are in `core/numbers.ts`), `redact.ts` keyed on `Declined` instead of reply text, and the MCP `output` schemas (the registry's `mcp.output` are loose placeholders).
- **Moved with `git mv`** (v1 imports updated): `reminders/schedule.ts` to `domain/reminders/`, `reminders/guard.ts` to `domain/reminders/guard.ts` (`tidyWhat` moved with it), `agent/validate.ts` to `core/values.ts`, `agent/memory.ts` to `domain/facts.ts` (the secret rules split out to `core/secrets.ts`), and their tests. `agent/schema.ts` takes its constants from `core/commands.ts`.
- **biome**: `suspicious/noThenProperty` is off in `biome.json`: `then` is `ask_user`'s field name.
- **Golden test**: 58 outcome cases (every write tool and status the outcomes have, 23 tool/status pairs) plus 15 lines code says that are not a write (lists, the forget-everything question, `ask_user` questions, declines): 73 in all. The v1 strings are a committed fixture, `test/golden/v1-replies.json`, captured from v1's own render code (`render.ts`, as `execute.ts` composes it) by `src/golden-v1.test.ts`, which asserts the fixture is v1's live output (rewrite with `UPDATE_GOLDEN=1`); `src/core/golden.test.ts` reads only the fixture, so it outlives v1, and **R3 deletes `src/golden-v1.test.ts` with v1**. The one difference allowed is the date format, checked structurally: 6 cases differ, all reminder dates (`5/12` to `05/12`, `4/1/2027` to `04/01/27`).
- **Races** (`src/core/concurrency.test.ts`, real Postgres only, `RACE_RUNS` repeats each race, default 6): two writes and an undo; three undos at once; an undo racing a forget; an undo racing a reminder cancel; an undo racing a sweep that ends a one-off (row lock, no account lock); other accounts never waiting. Checked: no error or deadlock, the turn log replays to the strict stack's law, and the live rows are what the commit order says. Run as the whole file 20 times in a loop against Docker `postgres:17` with `RACE_RUNS=10`: 20 of 20 passed (200 races of each kind).
- **What v1 tested and where it went** (the v1 tests stay until R3 deletes them):
  - `undo.test`: log, correction, delete, mixed, second undo, no undo of an undo, walking back, refusing (stale), all-or-nothing, other accounts, the 24 h limit, the correction after an undo, the audit: `core/history.test.ts`. Dropped here: "by voice and by the model", "what is not an undo" and the bare-"deshacer" shortcut (agent and `resolve`, R3 and R4); "a long undone batch is held under the WhatsApp limit" (`fitReply`, carried over, tested in `render.test.ts`); "summaries match independent SQL after an undo" (R3 with the summary queries).
  - `memory.test`: rules (secret, contact, key, value, category, numbers, traced words) in `domain/facts.test.ts` (moved) and `core/guards.test.ts`; storing, replacing, the cap, forgetting by id or key, forgetting all, the account isolation, undo of facts: `core/apply.test.ts` and `core/history.test.ts`; the facts the message names beyond the newest 30, the lookups of live facts: `domain/facts.contract.test.ts`. Dropped here: the context text, "¿qué sabés de mí?" as a conversation, the "sí" answers (`resolve.codeAnswer`, R4), redaction of a secret everywhere (R3 and R4; `commit({scrub})` is the part that is the core's). "An id and a key together, the id decides" has no counterpart: `forget_fact`'s target is `{id} | {key}`.
  - `reminder-agent.test`: set, past, far, secret, text, the cap, cancel, list, undo (set, cancel, several, sent, past, cap, the set a later cancel and a restore leave), a schedule that no longer parses: `core/guards.test.ts`, `core/apply.test.ts`, `core/history.test.ts`, `domain/reminders/db.contract.test.ts`, the golden test; "an undo racing the sweep": `core/concurrency.test.ts`. Dropped here: the model's context, the help text, a bare "baja", the sender sending it (R3, R5), "refuses when the reminder was cancelled by a later message" (that is now the strict stack: the later cancel is the turn the undo takes).
  - `words.test`: the model's own text beside the record. The spec deletes it for action tools (no `text`); `reply`'s numbers and claims check moves with `say.ts` in R3. `core/numbers.ts` keeps the primitives with `say.test.ts`'s cases.
  - `apply` and `ledger` tests were inside the end-to-end tests above: `core/apply.test.ts`, `domain/movements.test.ts` (search, filters, paging, newest).
- **Open**: `src/concurrency.test.ts > facts > an undo racing a forget` (v1) failed again once in a full real-Postgres run, and `src/webhook.test.ts > accepts a valid signature` failed twice under load on PGlite (`processing` instead of `done`: the harness's fixed 150 ms `settle()`). `settle()` now also waits, up to 2 s, while a row claimed in the last 5 s is still `processing` (3 of 3 `pnpm check` runs green after it). Both are v1 code that R3 and R4 replace. `test/migrations.test.ts` counted append-only triggers across the whole database; it now counts those of its own schema (the other test files hold schemas of their own at the same time).

### As built (R3, part 1: the agent library; the switch-over is not done)

- **Stopped at a green, pushed point, as the brief allows.** The new agent is a library in `src/agent/next/` (`models`, `context`, `examples`, `prompt`, `loop`, `reply`, `understand`, each with tests), beside v1, which still runs the app. The folder name exists only because v1's `loop.ts`, `prompt.ts` and `models.ts` still have those names: the switch-over deletes v1's `src/agent/*` and runs `git mv src/agent/next/* src/agent/`. Nothing of the app, the eval or the other tests points at it yet. **Not done:** the switch-over (item 2), the single-message eval port and deletion (item 3), and so the scenario eval proof. The scenario eval was not run; the only API spend is the smoke runs below (about US$0.04).
- **What the library does.**
  - `understand({sql, client, accountId, text, at, now?, photo?, voice?, help?, signal?, deadlineAt?})` reads the state (`readState`: the 10 newest movements, the facts the message names, live reminders, the conversation, the open question), renders one `Context` (`text`, `shown`, `evidence`, `window`), runs the loop, renders what code answers beside the writes (`reply.render`: totals, lists, `ask_user` options, `skip`, help; read before the commit, outside its transaction) and returns `{calls, compose, redact, declined, audit, turns, usage, turnLog, ms}`. The worker hands `calls`, `compose` and `scrub: redact` to `core/turn.commit`; `understand.test.ts` does exactly that.
  - `runAgent` is v1's manual loop on the registry: `checkValues` per call, then `checkTurn` over the turn; reads run and answer; held writes; a turn runs whole or not at all; the caller's `Shown` is copied, never mutated. A refusal (`stop_reason: 'refusal'`) throws `AgentError` with `refusal` = the category and an audit entry `{tool:'refusal', status:'refusal', detail: category}`, with no retry. Each call has `timeout: min(8 s, time left)` and `maxRetries: 1`, and no call starts after the deadline. Usage is `sumUsage(turnLog)` (`TurnTiming.cache_write_1h` is new, optional until v1 goes). A turn with no tool call gets one retry whose roster comes from the registry.
  - `reply.compose` renders every line from `describe` or `render`. Free text exists only in `reply`, through `checkReply` (v1's numbers check, made-of-pieces check and claims check; a claim's only proof is the window of earlier replies, since `reply` goes alone); a text that fails becomes `REPLY_SAY_FALLBACK`. `core/fit.ts` holds `fitReply` and `renderHeard` (moved out of `render.ts`, which re-exports them).
  - Moved to the new schema: the summary SQL (`domain/totals.ts`) and `domain/run-summary.ts` (on `planRange`). `render-summary.ts` is still v1's file (it takes the same row shapes structurally) and moves with the switch-over.
  - The model is Haiku 5.5 only (`ModelKey = 'haiku'`).
- **Measured against the real API** (`evals/prompt-tokens.ts` and `evals/agent-smoke.ts`; run with `node --env-file=.env --import tsx <file>`):
  - **Tokens of the frozen prefix** (tools plus system prompt, `claude-haiku-5-5`, the free count-tokens call): before 24,577 (v1's `TOOLS` and `SYSTEM_PROMPT` at 43184f0), after 25,858. That is +1,281 tokens (+5.2%). The prompt text got shorter (50,071 to about 46,500 characters) but the typed unions (`range`, `first`, `then`, `target`) and the new `skip` make the tool schemas larger. Trimming tool descriptions is left for a later slice.
  - **`max_tokens: 0` works:** the SDK types document it and the API accepted a warm-up with the real frozen prefix. `warmUp` uses it.
  - **Smoke, 13 real messages** (log, correct, summaries with `compare` and `dates`, two reminders, an ask, a correction plus a not-found part, forget, off-topic): each ended in 1 model turn with valid calls. Two fixes came out of it: the model put the verb in `skip.part` ("No encontré borrá el alquiler"), so the tool and the prompt now say it is a noun phrase; and `skipLine` writes "del" for "de el".
- **Switch-over, for the next builder** (commit at each green point):
  1. Delete v1's `src/agent/{loop,prompt,models,say,calls,schema,tools,index}.ts` and their tests, `git mv src/agent/next/* src/agent/`, fix the imports (including `evals/prompt-tokens.ts` and `evals/agent-smoke.ts`).
  2. Rewrite `store.ts` onto `wa_message`, `account_address` and `turn` (the claim, the send markers, the failure path, `upsertAccount` through `account_address`) and `process.ts` onto `understand` and `commit`: `before` is the claim's guard row, `after` sets `wa_message.turn_id`, `audit` and `timings`; `redact` also wipes `wa_message.text`. A refusal or any other `AgentError` goes to the failure path with its audit. Code answers (`resolve.ts`: "sí", bare "deshacer", numbered answers, link) read `turn.question` (`{options:[{n,id}], then}`, with `then.do` one of `delete`, `correct`, `ask_change`, `forget_all`, `link`) and become `Call`s for `commit` (`delete_movement`, `correct_movement`, `ask_user`, `forget_all_confirmed`, `undo_last`). Link and disconnect have no registry tool and stay worker-side until R4.
  3. Point `createWarren`, `test/db.ts` (`useDatabase` default `schemaDir`), `src/test-harness.ts` and `evals/scenarios/drive.ts` at the new schema. Delete what the brief lists (`store`, `ledger`, `apply`, `execute`, `undo*`, `facts`, `render*` after moving `render-summary` and the `REPLY_*` constants, `action-label`, `src/migrations/`, the v1 branch of `migrate`, `golden-v1.test.ts`) and the v1 tests that have a counterpart (the R2 note says where each went). MCP and the reminder sender sit on v1's `ledger` and `apply`: delete them with their tests, keep `graph.sendTemplate` and the door checks, and mark scenarios that fire a reminder `pending-R5`.
  4. Run the scenario eval with `--only` first. It exercises what the smoke did not: a search turn then a write, a numbered answer, facts, the photo and voice paths.
  5. Port the `evals/cases.jsonl` cases no scenario covers, delete `evals/run.ts`, `cases.jsonl`, `grade*`, `cache-probe.ts` and what only they use, and regenerate `results/latest.md`.

### As built (R4, with the switch-over of R3)

- **The tree is switched over.** v1 is gone: `store`, `process`, `ledger`, `apply`, `execute`, `undo*`, `facts`, `render`, `action-label`, `command-fixtures`, `run-summary`, `src/migrations/` and the v1 branch of `migrate`, v1's `src/agent/*` (`src/agent/next/*` moved up with `git mv`), the reminder sender, MCP's tools and writes, and their tests. `grep` for those names (files, imports, `inbound_message`, `createProcessor`, `createStore`, `agent/next`) over `src evals test package.json .github` finds nothing. `createWarren`, `test/db.ts` (`useDatabase` migrates `schemaDir`; it truncates the new tables), `src/test-harness.ts` and `evals/scenarios/drive.ts` run on the new schema. `render-summary.ts` moved to `src/domain/`, the canned worker texts (`REPLY_*`) to `src/whatsapp/replies.ts`, `isAllowed` to `src/access.ts`. `range.ts` lost `parseOther`/`planSummary`/`stray`'s caller (the typed `planRange` is the only entry).
- **WhatsApp channel** (`src/whatsapp/`):
  - `payload.ts` (text, image, audio; `media_id` and the replied-to wamid), `ingest.ts` (`createIngest`: `wa_message` insert with `ON CONFLICT (wamid) DO NOTHING`, the account and its `account_address` for an allowed sender, delivery statuses; a status for a `reminder_send` wamid goes to that table), `queue.ts` (the SQL of `wa_message` as a queue), `send.ts` (stamp-then-send: `deliver`, `once`, `fail`), `media.ts` (`fetchPhoto`, `hear`), `resolve.ts` (`codeAnswer(text, {question, typed, signIn})`, pure; returns a `call` for `commit` or one of link ask/confirm/decline and disconnect), `worker.ts` (`createWorker`: `kick(senders)`, `sweep`, `drain`, `stop`).
  - **Claim** (`queue.claimNext(sender)`, one statement): the sender's oldest due row (pending, or processing with a stale claim and no send started), only when no older row of that sender is open, uncommitted (`turn_id IS NULL`) and not stale; `FOR UPDATE SKIP LOCKED`. Housekeeping (`tidy`: `unknown` after a send started, `failed` out of attempts) runs only in `sweep`, which then starts one lane per sender with work, in parallel. A lane claims, works the row up to its commit point and claims the next; a kick that finds the lane running asks it to look again. Replies of one sender are sent in order (each waits for the previous message's whole work).
  - A **turn** is committed with `core/turn.commit`: `before` = the claim's guard row (`queue.holds`), `after` = `wa_message.turn_id`, `audit`, `timings` (and `text` = the transcript, or the placeholder when redacted). A photo/voice problem is a `notice` turn (label `notice`, no calls). Link and disconnect run their SQL in `before` (inside the transaction, label `link_ask`/...) and carry `question {options: [], then: {do:'link', link_id}}`. A refusal or any `AgentError` goes to the failure path with its audit (scrubbed when the text is a secret); `redact` wipes `wa_message.text`.
  - **`commit`'s `now` is the message's own time** (`meta_ts`), not the clock: the conversation window reads `turn.created_at <= at` of the next message, and a delayed turn stamped later than the next message's `meta_ts` would vanish from it. The agent's `now` (reminders) is still the later of the two.
  - Timings gained `model_ms`; `pnpm latency` reads `wa_message` and `turn.label`.
- **Not carried over, for R5 and R6.** R5 (reminders): the sender (`reminders/send.ts`: claim, window, cap, text or template, at-most-once) and its tests, the CLI (`template:status`, `reminder:try-template`, `reminder:add`, scripts removed from `package.json`), and the 24 h-window read of the reminder sender; `createWarren` has no `reminders` and `Config.REMINDER_TEMPLATE` is unused; `graph.sendTemplate` stays. Status webhooks for reminder wamids are handled in `ingest.ts` (a minimal port of v1's `recordReminderStatus`: no `sent_count`). R6 (MCP): `mcp/endpoint.ts` serves the door and a stateless `McpServer` with **no tools**; deleted: `mcp/tools.ts`, `mcp/write.ts`, `mcp/write-tools.ts`, `mcp.test.ts` and `mcp-write.test.ts` (the read-tool, write-tool, request-replay and two-people tests) and `mcp-test-kit.ts`. Kept: `door.ts` (its `wa_id` now comes from `account_address`) and its tests, `src/mcp/door.test.ts`, minus the two that need a tool (scope is each tool's; a token of one person is never the other). **Scenarios that need a reminder to fire: 0** (the driver never runs a sender), so none is marked `pending-R5`.
- **Tests.**
  - Channel (PGlite and Postgres): `webhook.test` (signature, 400/413, verify, duplicate wamid, retried batch, non-text, allowlist, statuses incl. reminders, no raw payload), `worker.test` (recovery, owner guards, failure incl. refusal and secret, interim, deadline, deadline during the commit, shutdown and hand-back, code answers: option number, "deshacer", "sí" to forget-all), `media.test` (photo and voice paths, notices, nothing stored but the media id), `resolve.test`, `payload.test`, `latency-report.test`, `door.test`, `auth.test` (the real sign-in through the worker).
  - Concurrency (real Postgres only, `src/whatsapp/concurrency.test.ts`, `RACE_RUNS` repeats each race, default 3): a burst of 6 from one sender answered in order whatever each model call takes; two senders in parallel (one stuck does not hold the other); the deploy hand-off (an old instance's claimed row is not overtaken by a newer row, then the old instance stops and a sweep answers both, the older first); a stale claim retaken once under two concurrent sweeps; a live holder blocks the sender, a stale one does not. A mutation (removing the `NOT EXISTS`) fails the hand-off and the live-holder tests. **The file ran 20 times in a loop against Docker `postgres:17` with `RACE_RUNS=5`: 20 of 20 passed (100 repetitions of each race).** The whole suite on `postgres:17`: 873 passed, 0 skipped. CI's `check` and `postgres` jobs were green on the pushed commits.
  - **First signal on bursts** (4 senders x 5 messages at once, model 40 ms, real Postgres; `FIRST_SIGNAL` line of the last test): receipt to typing indicator p95 = 164 to 173 ms over 20 runs (p50 about 85 ms, n = 20 per run). It waits for the lane; sending it on receipt is R7's experiment.
- **Single-message eval.** Deleted `evals/run.ts`, `agent.ts`, `command.ts`, `grade*`, `cache-probe.ts` and the `eval` script. Of the 157 cases, 137 had no scenario with the same text; **126 are ported** as scenarios `s215` to `s340` (single turn, same split, `source: synthetic`, the case id in `note`; 100 dev, 26 test): logs, corrections and deletions with the `recent` list as the seed (target = its `target_index`), the 7 queries with a seeded ledger and the total they must show, help and off-topic. Not ported (11): the 9 `ambiguous` cases (a question and a guess are both right, the scenario format has no "either"), `c085` (which income category a movement turns into is the model's call) and `c155` (asks for a time of day the list does not carry). Ported logs pin the category and a short key of the description (the last word, 5 characters), since the old cases' descriptions are free text. `evals/cases.jsonl` is left in place for reference and can go with the next slice's cleanup.
- **Scenario eval, 3 runs, `--split all`, 340 scenarios** (214 originals + 126 ported), `results/latest.md` regenerated:
  - Fully right 333, 334, 336 of 340 (median 98.2%); per-turn p50 1,143 / 1,166 / 1,151 ms (v1 1,192), p95 1,708 to 1,800 ms; p50 model turns 1; invented numbers 0; cost US$0.157 a run.
  - **Of the 214 originals** (the bar's denominator): 209, 210, 211 fully right (median 210; the bar is a median of at least 211), 0 silent wrong changes in every run, 0, 0 and 0 unnecessary questions apart from run 1's 2. **So the bar is not met: the median is one short.**
  - Silent wrong changes in the whole file: 1, 1, 0, both from ported cases whose pinned category or description key the model disagreed with (`s237` "aire" as transporte; `s250` "laburo" against a key of "traba"): grading artefacts of the port, not wrong data, but they are in the numbers.
  - **Failing in 2 or 3 of 3 runs** (fix or explain): `s114` "me cobraste dos veces el café?" (dev): the model answers with a `reply` that lists the cafés and their amounts and times; `checkReply` refuses it and the person gets the fallback line, so the numbers check rejects what `find`-less context showed; `s132` (dev), "ay no, volvé atrás con eso" with a question open: the model writes plain text three times and the message fails (`no valid action after 3 model turns`); the prompt lacks v1's rule that a "no, eso no" or "volvé atrás" while a question is open is an answer to that question (a `reply`), not an undo or text; `s065` and `s334` are held-out (the test split is not printed). In single runs: `s057`, `s100`, `s132` turn 1 ("borrá la nafta"): `ask_user` with one id and `then: delete` instead of `delete_movement` (the unnecessary questions), `s131`, `s016`.
  - Fixed while measuring (both were deterministic): the typed example "cafe 3000" with a fact moved the plain "cafe 3000" to entretenimiento (the example's message is now "cafe 2800"); "recordame 3 veces a las 8" was read as 20:00 today (the prompt now says "a las 8" is 08:00 and a time with no day that has passed is tomorrow's). The seeded ledger of the driver is one turn marked as already undone (v1's seed was no batch: "deshacer" on it must find nothing).
  - **Spend: US$0.866 recorded in `results/spend.jsonl` for this slice's runs, plus one run I stopped half-way (about US$0.1, not recorded): about US$0.97 of the US$1.00. Nothing was left to iterate on the failures above.** The three failures that are the model's (`s114`'s reply check, `s132`'s open-question "no", the single-id `ask_user` for a delete) are prompt and `reply` work for the next slice that has eval budget; `s114` may be `checkReply` being stricter than the evidence it is given.
- **Open / for the next builder.** `AGENTS.md` and `CLAUDE.md` still describe v1's layout and commands (rewritten at the end, spec section 6); `evals/cases.jsonl` and `evals/results/summary.md` remain; `Config.REMINDER_TEMPLATE` and `WarrenDeps.config.REMINDER_TEMPLATE` are unused until R5; the MCP endpoint has no tools until R6; `test/db.ts` still accepts `migrations: schemaDir` in files that pass it (now the default).

### As built (R5, with the close of R4's eval items)

- **R4's eval items (part A).**
  - A time with no day is today again (v1's rule); code declines a passed one with `reminder_past`. "A las 8" stays 08:00.
  - `ask_user` with `then: delete` over one id is refused by `checkValues` ("call delete_movement"); a single-id `correct` and `ask_change` stay (they are the legitimate single-candidate questions, and the pending-question rewrite in `checkTurn` is untouched). That also cleared `s057`, `s100` and `s132` (its "volvé atrás" came after a wrong open question). The prompt gained v1's rule in the pending-question section: a refusal ("no", "no, eso no", "volvé atrás") with a question open answers that question with a `reply`; new scenario `s341` pins it.
  - **`s114` was the reply check refusing the model's own words (it counted the cafés in words).** Fixed in the loop, not the prompt: `runAgent` takes `vet(text, found)`, and a `reply` that `checkReply` refuses goes back to the model as an error result with the reason and another turn (the last turn is let through, and `compose` still falls back). The movement lines the model reads show amounts as people read them (`$3.500`, `US$ 1.500`), so it copies that form. Code still renders every list, total and record; this only gives free text a second try.
  - `s237`: "aire" at a petrol station is `combustible` or `transporte`, so only the nafta pins its category. `s250`: the description accepts `laburo` or `trabajo` (the scenario format gained a list of accepted words for a new movement's description). Notes say why.
  - Deleted `evals/cases.jsonl` and `evals/results/summary.md`. `--repeat` does not exist in `run.ts` (the thread's brief assumed it).
- **Scenario eval, 3 runs, `--split all`, 341 scenarios** (the 214 originals, 126 ported, 1 new): fully right 337, 337, 337 of 341 (98.8%); **of the 214 originals 212, 211, 211 (median 211, the bar)**; the 127 others 125, 126, 126. 0 silent wrong changes, 0 invented, 0 unnecessary questions in every run. Per-turn p50 1,168 / 1,164 / 1,162 ms (v1 1,192), p95 1,736 to 1,827 ms; cost US$0.16 a run. **Not met: three held-out scenarios, `s016`, `s065` (originals) and `s334` (ported), fail in 3 of 3 runs.** The builder does not read held-out details, so they are not diagnosed: someone with access to the test split has to look (`s016` is new in the failing list; R4 listed `s065` and `s334`). Dev failures were one different scenario per run (`s293`, `s153`, `s117`), each once. Spend this slice: US$0.69 recorded in `results/spend.jsonl` (four full runs, one of them superseded, and small `--only` runs), plus a stopped run not recorded.
- **Sender** (`src/domain/reminders/send.ts`, v1's rules kept as they were): one claim per transaction (`FOR UPDATE OF r SKIP LOCKED`, the account lock never taken), `reminder_send` keyed `(reminder_entity_id, due_at)` is the at-most-once marker (`ON CONFLICT DO NOTHING`), the 23 h window from `COALESCE(meta_ts, received_at)` read in `wa_message`, text inside it and the template outside it, 131047 as a 4xx answer falls back to the template and as a later status (`ingest`) becomes `retry_template` and is claimed once, the allowlist, the cap of 10 in a rolling 24 h per person (`reminder_send.account_id`, no join), the alert above 200, `stop(10 s)`, no template when `REMINDER_TEMPLATE` is unset. `OUTSIDE_WINDOW` and `TEMPLATE_LANGUAGE` moved to `whatsapp/graph.ts` (ingest uses the same constant). The address comes from `account_address` (channel `whatsapp`); a reminder of an account with none stays due and is never sent.
- **A one-off that fires ends as `next_due_at = NULL`, not as an ended version.** An ended version needs a turn (`ended_in` is a foreign key and the pair CHECK), and the sweep has none: the turn row is the commit point of a person's work. R2's history already reads a live reminder with `next_due_at NULL` as "already sent" (`blocked: sent`), and the reminder lists and the cap skip it, so it shows as done to the undo. Checked end to end in `send.test.ts` ("a one-off that fires") and in the race below.
- **`createWarren`** builds the sender (`reminders`, with `deps.clock` and `config.REMINDER_TEMPLATE`), `sweep` runs the worker's and the sender's sweeps side by side (a failure of one does not stop the other), and `stop` stops both with the same grace. `server.ts` already calls them on the 30 s tick. `evals/scenarios/drive.ts` still drives the worker only, so no scenario sends a reminder.
- **CLI:** `pnpm template:status` and `pnpm reminder:try-template` (`src/domain/reminders/cli.ts`, on the config's `reminderTemplate` and `createGraph`). **`reminder:add` is dropped:** it inserted a reminder by hand for a manual test, and the R8 probe sets its reminder with a signed webhook ("recordame en 1 minuto") like a person, so it needs nothing of it.
- **v1's `send.test.ts` ported case by case** (`src/domain/reminders/send.test.ts`, 50 tests): every group of v1's file (the window, at most once, recurring and downtime, the caps, no template, status webhooks through `createIngest`, the window from Meta's time, 131047 after a 200, who may be sent to, shutdown), plus three new: a message with no `meta_ts`, an account with no WhatsApp address, and a one-off that fires is `blocked` for the undo. **Not ported:** "does not count what the person said over MCP" (`wa_message` is WhatsApp only: only the "another person" half remains) and the `insertReminder` cases (R2's `db.contract.test` and `guards.test` hold them). "Cancelled" now cancels through a real turn.
- **Races** (real Postgres only): two and four sweeps at once send each of 8 occurrences exactly once; a recurring reminder swept by two at once is sent once and advanced once; an undo racing the sender, in `send.test.ts` (it sets the reminder, so it is taken back with nothing sent, or sent and the undo `blocked`) and in `core/concurrency.test.ts` (R2's simulated sweep now runs the real sender). **The two files ran 20 times in a loop against Docker `postgres:17` with `RACE_RUNS=5`: 20 of 20 passed.** A mutation (`FOR SHARE` instead of `FOR UPDATE` in the claim) fails three of them with a deadlock. The whole suite on `postgres:17`: 924 passed, 0 skipped; `pnpm check` on PGlite green.
- **For the next builder.** R6 (MCP reminder tools) can set reminders through the registry: the sender reads `reminder` and `account_address`, nothing else. R8's probe needs `REMINDER_TEMPLATE` unset or the graph-sink to answer the template, and the person's window is whatever `wa_message` holds: a probe that sends first (as it does) is in the window.

### As built (R6, with the three regressions of the held-out split)

- **Part A.**
  - **A one-option question is allowed again.** The R5 guard that refused `ask_user` with `then: delete` over one id is gone (`guards.ts`). The rule that serves both classes is in the prompt and rests on what the model knows, with no word-matching: the one movement the person named is `delete_movement` or `correct_movement`; `ask_user` over one id is only for when what they said fits nothing and that one is the only movement to offer. Measured on dev scenarios of both classes, 3 of 3 runs: named exactly, so act (`s057`, `s100`, `s348` to `s350`); nothing fits and one movement exists, so ask, and then "sí", "dale" or "ese" applies it, for delete and correct (`s351` to `s355`). `askLine` (`core/describe.ts`) says "¿Cuál?" with one option unless `then` is `ask_change` (v1's wording; the golden fixture is untouched, one more assertion in `describe.test.ts`). The "sí" was already answered by code (`resolve.ts`).
  - **Ported cases that lost their first turn.** Of the 12 cases with `previous`, 4 had been ported as one-turn scenarios (`s334` c141, `s335` c143, `s336` c144, `s339` c154): they are two turns now, the earlier message with its expectation and then the answer. Six had been skipped as "same text as a scenario" (a bare "2" or "sí" matches any scenario's text, in another context): ported as two-turn `s342` to `s347` (c140, c142, c145, c146, c152, c153). Not ported: the two `ambiguous` ones (c150, c151). c154's total is `$43.700` because its earlier turn corrects the gimnasio to 19000, as its `previous` reply says. Done by a script from the v1 cases (`git show v1-final:evals/cases.jsonl`); no held-out result was read.
  - **A greeting plus a question about Warren is `help`.** The prompt's `help` rule says what it is for (a question about what Warren is or does, with or without a greeting before it) and the examples have two more; four dev scenarios with other wordings (`s356` to `s359`).
  - **`s293`** ("poné el café como entretenimiento") failed 2 of 3 as a `remember_fact`. The prompt now says a movement they point at is a correction and a rule for every such expense is a fact (3 of 3 clean, with the memory scenarios).
  - **A mistake of mine, fixed.** A `sed` rewrote the expectations of `s034` and `s110` (the second is held out) in the first commit, and the three full runs below were made with them broken: the 2 silent wrong changes per run are those two. The next commit restored them and `--only` runs (3 of 3) pass. **There was no budget left for three more full runs**, so `results/latest.md` shows the three runs as they were; with those two scenarios right they would be 358, 354 and 358 of 359.
  - **Eval, 3 runs, `--split all`, 359 scenarios:** fully right 356, 352, 356 (median 99.2%); 0 invented numbers; unnecessary questions 0, 1, 0; per-turn p50 1,145 / 1,146 / 1,156 ms (v1 1,192), p95 1,709 to 1,778 ms; second model turn 2.9% to 3.9%. Held out (76 scenarios): 75, 72, 75 right (the one missing in runs 1 and 3 is `s110`). Dev failures in 2 of 3 runs: `s034` (mine) and `s293` (fixed since). **Spend of this slice: US$0.665 of the US$0.70** (three full runs at US$0.17, the rest `--only`).
- **Part B, MCP and auth on the registry.**
  - **Mounts.** `app.ts` has the webhook, `auth` (the authorization server: better-auth, `.well-known`, the sign-in and consent pages) and `mcp`. `createWarren` builds one `Auth` and both. `auth/http.ts` and the `req.auth` mutation are deleted.
  - **`/mcp`** is `toNodeHandler({fetch})` (`@modelcontextprotocol/node` 2.1.2 takes `{fetch}` and passes `options.authInfo` on), where `fetch` is: the public host, `originValidationResponse` (server 2.4.0; it compares hostnames whatever the port and scheme, so `clients.ts` gives hostnames), the door, then `createMcpHandler(...).fetch(request, {authInfo})`. The door takes a web `Request`. A refused origin is now the SDK's JSON-RPC 403.
  - **`mcp/clients.ts`**: `CLIENTS` (name, hosts, origins), `clientIdAllowed`, `originHostnames`. `auth/config.ts` no longer owns the host list.
  - **Tools** (`mcp/tools.ts`): one per registry entry with an `mcp` block (12: find, summarize, list facts, list reminders, log, correct, delete, undo, remember, forget, set and cancel reminder), named `warren_<tool>`, with the entry's own `input` plus `extra` (`request_id`, `limit`, `cursor`). Outputs are real zod schemas in `commands.ts` (`OUTPUTS`: movements with `amount` and `display`, totals, groups, comparisons, facts, reminders; writes with `record`, `turn`, `replayed`; an undo lists `items`, what came back, reminders too). The inputs are the canonical ones (`compare`, `target`, `first`), not v1's, so a client that cached v1's tool list must refresh it. A refusal is an error result with `structuredContent {code, message}` and the line Warren says. Codes: `invalid` (the guards' reason), the decline codes `secret`, `contact`, `reminder_past`, `reminder_far`, the outcome statuses (`gone`, `full`, `past`, `nothing`, `expired`, `restricted`, `stale`, `blocked`), `request_id_reused`, `no_whatsapp_address`, `unavailable`.
  - **Writes** go through `checkValues` and then `core/turn.commit` with `channel: 'mcp'`; every store is undoable. Under the account lock (taken in `before`) it checks the replay: `mcp_request(account_id, request_id)` with the `input_hash` of tool and checked input. The first answer comes back with `replayed: true`; another call under the same id is refused (`request_id_reused`). The row is inserted in `after`, in the turn's transaction. A call that changes nothing (a refusal, a no-op) throws inside `compose`, which rolls the transaction back: no turn, no row, and the id can be sent again. Six parallel calls of one request write once.
  - **Reminders over MCP.** `set_reminder` declines with `no_whatsapp_address` when the account has none (checked under the lock; `whatsappAddress` is in `src/access.ts` beside `isAllowed`, which R4 already moved there). The door admits only an account with a WhatsApp address, so over HTTP this is unreachable today; the test calls `runTool` for an account with none.
  - **`disconnect.ts`** stays on SQL inside the commit's transaction (better-auth's adapter has no transaction handle and no delete-by-JSON). `auth/disconnect.test.ts` pins the `LIKE` on a real code issued before the cut; a mutation of the fragment fails it.
  - **Tests.** `mcp/tools.test.ts` (protocol, scope per tool, the account from the token alone, finds, summaries, facts, reminders, `listGroups`), `mcp/write.test.ts` (writes, typed refusals, undo over every store, `request_id`), `mcp/e2e.test.ts` (discovery, CIMD client, sign-in by code on WhatsApp, consent, token, `tools/list`, a read, a write and its replay; WhatsApp "deshacer" takes back an MCP write with no model call; an MCP undo takes back a WhatsApp write; the newest turn of either channel in order), `auth/disconnect.test.ts`. The two door tests R4 dropped are back in `tools.test.ts` (scope is each tool's; a token of one person is never the other). Shared helpers: `src/mcp-test-kit.ts`. `pnpm check`: 958 passed, 15 skipped (PGlite). Real `postgres:17` (Docker): 973 passed, 0 skipped.
  - **v1's MCP test cases not ported, and why.** "A secret keeps no inputs in the command, audit or body": `checkValues` declines a secret before anything is stored (the `remember_fact` test). "A page of 50 is far under what a client takes": replaced by "51 is refused". "Refuses a value that does not fit and a full account": the full case is `apply.test` and `describe.test`, the value case is the guards'. "The MCP rows are not WhatsApp messages" (4): there is no MCP row in `wa_message` now (one assertion in `write.test.ts`). "Refuses a batch of reminders": reversed on purpose, MCP undoes every store. "Refused past 24 hours": `core/history.test.ts`. The two races on real Postgres (MCP correct against WhatsApp correct, MCP undo against "deshacer"): one `commit` path, tested by `core/concurrency.test.ts`; the burst of one `request_id` is in `write.test.ts`. "The help tells how to disconnect", "a message with more in it goes to the model", "an open question is answered first": worker and `resolve.test.ts`.
  - **For the next builder.** R6 changed nothing the agent reads, so it ran no eval of its own. `AGENTS.md` and `CLAUDE.md` still describe v1. `originValidationResponse` matches hostnames, so `http://claude.ai` would pass it; a browser cannot be made to send that origin from `https://claude.ai`.

### As built (R7, the measured experiments)

Spend: **US$1.356 of the US$1.40** (`results/spend.jsonl`, every run below). Pre-search and the first signal are adopted; `tool_choice any` is not decided: its full run did not fit the budget (see 1).

- **0. Control.** The first three runs of the R6 head had 2 silent wrong changes each: `s321` ("cafe $3.500 (con la visa) ayer", dev, 3 of 3) logged a café as entretenimiento, and one held-out scenario in each run (not read). Cause of `s321`: the typed example for a category fact was about "cafe" -> entretenimiento, and the model applied it to plain cafés. Fix: the example is about a lavadero (`eb7435c`). Those three runs cost US$0.517 and are superseded.

  | Control, head `eb7435c`, `--split all`, 359 scenarios | run 1 | run 2 | run 3 |
  |---|---|---|---|
  | scenarios fully right (of 359) | 357 | 358 | 357 |
  | of the 214 originals | 212 | 213 | 212 |
  | silent wrong changes / invented numbers / unnecessary questions | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
  | per-turn p50 / p95 (ms, webhook to stored reply) | 1,175 / 1,738 | 1,160 / 1,709 | 1,147 / 1,751 |
  | second model turn (share of turns that called the model) | 8 of 414 (1.9%) | 11 of 414 (2.7%) | 11 of 414 (2.7%) |
  | cost | US$0.170 | US$0.172 | US$0.172 |

  Bar met (median 212 of 214, 0 silent, 0 invented). **Two scenarios fail in 2 or 3 runs:** `s016` (held out, tags `other`) fails 3 of 3, so it is not diagnosed here (someone with the test split has to look); `s153` ("¿gasté más que el mes pasado?", dev) fails 2 of 3: the model sends `compare: {period: last_month}` (the whole month) instead of `compare: "previous"` (the same stretch); a prompt line against it still failed 1 of 3 and was reverted. `results/latest.md` is these three runs.
- **1. `tool_choice: {type:'any'}` on Haiku: not adopted, not decided.**
  - **Checked first.** Haiku 5.5 accepts it with thinking off (no 400 in 3 runs of the long set and 1 of 15 scenarios). `reply` and `skip` are registry tools, so a forced call always has an answer; the no-tool retry becomes unreachable. Changing `tool_choice` between requests does not touch the cached tools-plus-system prefix (the cache docs: it only invalidates the messages level; the frozen prefix stays one block). `warmUp` must not send it (`max_tokens: 0` is rejected with `tool_choice` any), so the setting belongs on the call in `runAgent`, not in `requestBase`.
  - **Measured, but not on the adoption rule.** The adoption rule needs one full run (US$0.17) and, if it holds, two more; after pre-search only US$0.044 was left. What was run instead, on the long-ledger set (22 scenarios, pre-search on) and a 15-scenario selection (the council's ambiguous-pick list, one-option questions, the older-item scenarios):

    | arm (long-ledger set, 3 runs each) | control | pre-search | pre-search + `tool_choice any` |
    |---|---|---|---|
    | fully right (of 22) | 20, 20, 20 | 21, 21, 20 | 21, 21, 21 |
    | silent wrong changes | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |
    | second model turns (of 22) | 19, 19, 19 | 5, 6, 4 | 5, 5, 5 |
    | per-turn p50 (ms) | 2,301 / 2,295 / 2,264 | 1,313 / 1,291 / 1,281 | 1,121 / 1,100 / 1,098 |
    | cost per run | US$0.0172 | US$0.0117 / 0.0125 / 0.0112 | US$0.0114 |

    The 15-scenario run: 15 of 15, 0 silent, 0 second turns. So forcing the call cost no accuracy here and was about 190 ms faster per turn, but this is 22 scenarios on one ledger, not the 359 the rule asks for.
  - **Committed as `cb90c30`, reverted in `3e9fe14`** so the history shows it. For the next slice with budget: one full `--split all` run costs US$0.17; the rule needs three (US$0.52). The change is one line in `runAgent`'s `messages.create` (`tool_choice: {type: 'any'}`).
- **2. Pre-search: adopted.** `mentionedMovements` (`domain/movements.ts`) returns the live movements outside the 10 newest that have a word of 4 or more letters of the message at the start of a word of their `search` column, or an amount the message writes (`21.000`, `3500`, `12,50`), newest first, at most 8 (`MENTIONED_LIMIT`). It reads the existing `search` column and ranking; it never picks. `readState` runs it beside the other reads, `renderContext` shows the rows after the recent list with a line that says the code searched by the message's words and the model decides (or asks, or searches as before), and their ids join `shown` and the numbers evidence. No prompt change (the context line carries the rule), so the cached prefix is untouched.
  - **The set:** `evals/scenarios/long-ledger.jsonl`, 22 scenarios `s360`-`s381` (separate file; `run.ts --file`, saved as `-long.json`, not in `--split all`), one seeded ledger of 45 movements from 22/09 to 21/11. Targets are older than the 10 newest (21 of 22; "el súper de ayer" is in the list, as a trap): by name, by amount (`21000`, `9200`, `38000`), by date ("el lunes pasado", "lunes 9", "2/11", "12/10", "de octubre"), the older of two similar ones (three naftas, four farmacias, two cafés, two alquileres), a multi-action, a synonym (`peluquera` for peluquería), nothing that fits, and traps where a word matches by accident (`mamá` is in an older "farmacia mamá" while the message logs a taxi; `Lucía` is in an older regalo while it logs a pizza; older súpers while the message means yesterday's). `scenarios.test.ts` pins the shape. `s378` ("nothing fits") first expected a question and was fixed to "nothing changes, the reply says it did not find it" after the control run, because the typed `skip` is the answer by design; the control's failure there was the expectation, not the model.
  - **Result:** table above. Second turns 19 of 22 (86%) in each control run against 5, 6, 4 (18 to 27%): down 74%, with 0 silent wrong changes in all 6 runs. The traps held: no run corrected the "farmacia mamá" or the older regalo for the taxi and the pizza. The synonym scenario (`s377`) fails in both arms, as it must: no word of the message is in the description.
  - **Full run with it on** (1 run, US$0.172, the budget allowed one): 355 of 359; **211 of the 214 originals** (the bar's median; one run); 0 silent wrong changes, 0 invented numbers, 0 unnecessary questions; second model turn 10 of 414 (2.4%); per-turn p50 1,210 ms, p95 1,762 ms (control p50 1,147 to 1,175, p95 1,709 to 1,751: the p50 is 35 to 63 ms above the control, inside v1's +150 ms). The failures: `s016` (held out, as in the control), `s153` (as in the control), `s161` and `s341` (dev, each seen once; not in the control, not diagnosed). **One run is not three:** the next slice with budget should repeat it. The file is `evals/scenarios/results/2026-11-23T00-03-13-208Z-all.json`; `results/latest.md` was not regenerated from it (a median of one run), so it still shows the control.
- **3. First signal on receipt: adopted.** `queue.signalWaiting(waId)` stamps `typing_sent_at` on the sender's pending rows that wait behind an older open, uncommitted row and have no signal yet (stamp first, so two kicks never both send), and `worker.kick` then sends `markReadAndType` for each, for allowed senders only, before it looks at the lanes again (the signal's UPDATE can hold a row a claim wanted for a moment; the claim skips locked rows, so the lanes are asked again after it). The lane still sends the indicator at its own claim (the reply to the message before may have cleared the first one); only a retried row (`attempts > 1`) skips it. `recordTyping` keeps the first stamp (`COALESCE`), so `typing_sent_at - received_at` is the first signal. The Graph call is the existing read-and-typing one (the indicator needs the message id, so it is also the read receipt; it lasts up to 25 s or until a reply is sent), nothing new in `graph.ts`. Stamp-then-send for replies and the interim note, and the owner guards of the lane's writes, are untouched (the new UPDATE writes one column of rows nobody owns).

  | R4's burst test (4 senders x 5 messages, model 40 ms, real Postgres `postgres:17`), 20 runs x 20 messages = 400 receipts | before | after |
  |---|---|---|
  | receipt to typing indicator p50 | 84 ms | 0 ms |
  | p95 | 170 ms (per-run 164 to 172) | 6 ms (per-run 4 to 6) |
  | max | 180 ms | 8 ms |

  p95 drops 96%. Proof: the whole suite on `postgres:17` 981 passed, 0 skipped; `src/whatsapp/concurrency.test.ts` 20 of 20 loop runs with `RACE_RUNS=5`; two new tests in `worker.test.ts` (a queued message is signalled while the first is still in the model; a sender who is not allowed is not), the first fails with the signal turned off. `pnpm check` green. The measured burst has no model cost; the Graph double answers at once, so a real Graph call adds its own 100 ms or so to both columns equally.
- **For the next builder.** `AGENTS.md`/`CLAUDE.md` still describe v1. Open: `s016` (held out) fails 3 of 3 in the control; `s153` flakes; the `tool_choice any` full run and its two confirmations; pre-search's full run should be repeated 3x. `results/latest.md` is the control (3 runs of the head before pre-search); after pre-search and the first signal, regenerate it from three new `--split all` runs.

### As built (R8, Ops)

- **Railway as code** (`.railway/railway.ts`): production's settings are unchanged (`railway config plan` on production says "already up to date"). The `staging` environment (created empty with `railway environment new staging`, not a copy of production, so it holds none of production's variables) has its own `warren` service (source `ticianomorvan/warren`, branch `rebuild`), `Postgres` (1000 MB volume) and `graph-sink`, and gets `overlapSeconds: 15` and `drainingSeconds: 15` (both are `DeployConfig` fields of `railway` 3.17.0; Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is how the app can read it). **R9: add the two settings to the production branch of the file** and run `railway config apply --environment production`; `cutover.ts` step 5 applies the config. Service domains cannot be declared in the file ("custom-domain registration is not supported"), so staging's two `*.up.railway.app` domains were made with `railway domain`. Staging variables were set with the CLI (no secret in the file): fresh random `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` (`fake-...`) and `BETTER_AUTH_SECRET`; `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` and `GRAPH_API_VERSION` copied from production without printing them; `REMINDER_TEMPLATE` unset; `GRAPH_BASE_URL=http://${{graph-sink.RAILWAY_PRIVATE_DOMAIN}}:8080`; `ALLOWED_WA_IDS` = 40 synthetic numbers `54911000000001..40`. **Delete staging after cutover:** `railway environment delete staging`.
- **`GRAPH_BASE_URL`** (`config.ts`, `createGraph({baseUrl})`): unset means Meta's. A media URL on the configured base's own origin is trusted (http included, for the private network); Meta's host check is unchanged for everything else.
- **`scripts/graph-sink/`** (`server.ts`, Node built-ins only, `server.test.ts`, `fixtures/voice.ogg` and `receipt.png`, both synthetic: macOS `say` and a drawn receipt): accepts send, template and read-and-typing, serves `GET /sent?since=` (bearer `SINK_TOKEN`), and the two fixtures through the Graph media lookup (`fixture-voice`, `fixture-photo`). In memory: a restart empties it.
- **`pnpm probe staging|production`** (`scripts/probe.ts`; settings come from `railway variables`, no secret printed). Staging, one run of 14 steps in about 110 s: health, verify handshake and a refused bad signature, log, correct, undo, a question then its answer (forget everything, "sí"), the voice and photo fixtures, a reminder in 1 minute that fires once (one `reminder_send` row, still one 20 s later), MCP 401 and metadata, discovery, a minted token, MCP read, write, replay and the WhatsApp undo of the write. Each step asserts on the sink and on the database through a **read-only connection** (`default_transaction_read_only`); the one write is the `auth_user` row for the minted token. Each run takes the first unused number of the allowlist, so it starts from an empty account (extend `ALLOWED_WA_IDS` after 40 runs). **The MCP token is minted, not signed in:** the real flow needs a client metadata document on `claude.ai`, which the server fetches and only from the hosts in `clients.ts`; staging cannot serve one there. The token is signed with staging's own key (`auth_jwks` decrypted with its `BETTER_AUTH_SECRET`), for a user linked to the probe's account; the door still checks signature, issuer, audience, expiry and the user. `production` mode: health, the verify handshake, the MCP 401 and metadata, OAuth discovery; it sends nothing and writes nothing.
- **`scripts/import-v1.ts`** (`--from`, `--to`, `--verify-only`, `--days`): live rows only. A corrected or deleted movement, a replaced or forgotten fact and a cancelled reminder are **not** imported (they stay in the old database, which the rollback keeps): ended versions are not kept as ended. Per account, one `import` turn made the versions; it is stored as an undo of an empty anchor turn so `lastTurn` never offers it (tested), which is how "batches older than the cutover can't be undone" holds. Entity ids are new (v1 ids are not kept). Also copied: accounts and addresses with their ids, `reminder_send` of live reminders (so a sent occurrence is not sent again), all auth tables row for row, and the WhatsApp messages of the last 30 days as identity and state only (no text, no media id; one still open at the cutover becomes `failed`). Verify compares counts, per-account sums per currency and md5 fingerprints; it prints no description, no amount of a single movement and no number. Tests (`scripts/import-v1.test.ts`, 8, on PGlite and on `postgres:17`) use synthetic v1 rows in a database built from `test/v1-schema/001_v1.sql` (the structure of production, no data), and tamper with the copy to show each kind of mismatch is caught. On a local copy of production's dump: 1 account, 19 live movements (18 ARS = 2,410,100 and 1 USD = 10; 40 rows in v1 in all), 2 facts, 3 reminders (none with a `next_due_at`: all are sent one-offs), 1 auth user, 1 OAuth client, 113 wamids; **15 of 15 checks match**.
- **`scripts/cutover.ts`**: the six steps, each logged to the terminal and a file, and `rollback` (DATABASE_URL back to `${{Postgres.DATABASE_URL}}`, then the tag `v1-final` deployed from a temporary worktree). `--dry-run` reads a dump of production (a read; `--dump <file>` skips it), restores it into a throwaway Docker Postgres that also holds the new database, runs 1 to 4 there, prints step 5's commands, and runs the read-only production probe. A real run needs `--new-url` (the new empty Postgres) and `--old-stopped`. **For R9:** put the old service to sleep before running it (writes between the dump and the import are lost), create the new Postgres first, and run the rollback only if step 6 fails.
- **Open:** the `pnpm probe staging` question step depends on the model choosing `forget_all_facts` for "olvidate de todo lo que sabés de mí"; an "ambiguous correction" scenario was tried first and the model picked the newest row instead of asking (twice), so it is not used. Probe model spend is estimated, not metered: about US$0.03 over 8 runs.

### As built (R9 fixes, part 1: core, domain, agent, WhatsApp)

From `docs/rebuild/` review findings at 7aa5a6e, built in the order bugs, design, docs, D6, D7. Each bug has a test that fails without its fix (checked by stashing the fix). Commit shas are the ones on `rebuild`.

**Proof, final head `e0b7073`** (code identical to `1b88200`; the later two commits are the D7 experiment and its revert).
- `pnpm check`: 984 passed, 15 skipped (PGlite). Real `postgres:17` (Docker, stopped after): 999 passed, 0 skipped; the whole concurrency, core-race and reminder-sender files 5 times with `RACE_RUNS=5`: 5 of 5. CI green on both jobs at the pushed heads (one red run, `ee6b890`, was the intermediate D5 commit that the next commit fixed).
- Scenario eval, 3 runs, `--split all`, 365 scenarios (the 359 plus 6 new dev ones):

  | | run 1 | run 2 | run 3 | median |
  |---|---|---|---|---|
  | fully right (of 365) | 364 | 363 | 364 | 364 |
  | of the 214 originals | 213 | 213 | 214 | 213 |
  | silent wrong / invented / unnecessary | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | |
  | per-turn p50 / p95 (ms; v1 p50 1,192) | 1,168 / 1,789 | 1,228 / 1,836 | 1,206 / 1,849 | 1,206 / 1,836 |
  | second model turn | 1.4% | 2.1% | 3.1% | 2.1% |
  | cost (US$) | 0.1737 | 0.1748 | 0.1761 | |

  Failures: `s153` (run 1), `s131` and `s290` (run 2), `s341` (run 3): all dev, none in 2 of 3 runs. Every failure is a visible dev scenario, so the held-out split passed in all three. The bar (median 213 of 214 >= 211, 0 silent and 0 invented in every run, no scenario failing twice, p50 +14 ms against v1) is met. `results/latest.md` is regenerated from these three runs.
- Long-ledger set, 3 runs: fully right 21, 21, 21 of 22; second model turns 6, 4, 5 of 22 (R7: 5, 6, 4); 0 silent. Pre-search keeps its R7 numbers.
- **Spend:** US$1.30 recorded in `results/spend.jsonl` for this slice (the D6 control and fix runs, the D7 run, the final 3 + 3), of the US$2.00 brief; the rebuild has used about US$5.50 of the US$7 cap.

**Bugs**
- B1 fixed `54f19df`: `checkValues` puts the resolved `Schedule` into the `set_reminder` call; `commit` takes a `clock` read at the commit point and `applyCall` re-checks the approved schedule against it (`past` if it has gone by). `ApplyContext` has `at` (the message's time: `logged_at`, the undo window) and `now` (the scheduling clock). An undo's restore of a reminder still counts from `at`.
- B2 fixed `54f19df`: reads (`summarize`, `list_facts`, `list_reminders`, `ask_user` options) are rendered inside the commit transaction after the writes, through `compose(tx, done, record, turnId)`.
- B3 fixed `9a3d932`, differently from the finding: the rule of what holds a sender back is the queue's alone (`createQueue({blocking})`: only a kind that goes through the agent, an audio only when something transcribes it), so a sticker or a reaction never holds the next message and the early `release()` is safe. The lane-waits-and-claims-again fix would have retried a rate-limited send at once, which two existing tests pin as not happening. Test: a slow sticker reply, then a log, answered with no sweep. The SIGTERM overlap case (a row the old instance hands back) still waits for the next sweep, at most 30 s.
- B4 fixed `85b2e3d`: `readForText` runs facts and pre-search on what was heard.
- B5 fixed `c359672`: pre-search reads amounts with `core/numbers` tokens (`3500.`, `1.500,50`).
- B6 fixed `040930d`: `Shown.movements` maps entity id to the version shown; `checkTurn` (code) attaches `version` to `correct_movement` and `delete_movement`, a question's options carry `v`, and `lockLive` returns null (`gone`) unless the live version is that one or one this turn made. MCP stays entity-only.
- B7 fixed `b0bc06c`: the open question skips `notice` turns; the live question is found by its turn id. The prompt now says one thing, v1's: a bare number with no open question is `help`, "borrá el 2" is a position.
- B8 fixed `f6c9b59`: an unreadable reminder blocks the undo, by name (`BlockedBy` `unreadable`); "scheduled" (live with a `next_due_at`) is one SQL fragment (`SCHEDULED`) and named in the schema comment. The old test that undid the log around such a reminder is replaced: the strict stack blocks the turn.

**Smaller bugs**
- Fact key as substring, `LONG_DIGITS` joining amounts, leading zeros, year 0: fixed `13a424b`. The key matches whole words with a plural allowed ("cafe" is in "los cafés"). A card is 13+ digits plain or in groups of 4 to 6; four 4-digit amounts with spaces (`1500 2000 3000 4000`) still read as a card.
- `summaryRows` in one statement (grouping sets), paging by entity id (`beforeEntity`, the MCP cursor is the entity id), the failure notice after the interim note and typing, secrets wiped from rows that end with no turn (`tidy`, `settle`), `GRAPH_BASE_URL` with a path refused, schema constraints (`UNIQUE (id, account_id)` on `turn` and composite FKs for `made_in`, `ended_in`, `undoes`; `undoes < id`; no `next_due_at` change on an ended reminder; ids as bigint read as numbers by the driver, so no `::int` cast is left), the untrusted-text labels in the context: fixed `f1ce54b`. The live-question index: in B7.

**Design**
- D1 fixed `54f19df`: `claim`, `guard` (may `{stop}`), `compose(tx, ...)`, `requireChange` (`{unchanged}`); `lockAccount` is private; `answerSignIn` is in `auth/answer.ts` (with the sign-in texts); MCP's write builds its result once. `after` gets the `done` of the turn.
- D2 fixed `8c0c595`: `stale`, the fact reclaim, both caps, `settledTurns` and `BlockedBy` `cap` are deleted; `asLeft` throws. No real path reached them; a marker turn that hides a turn now proves the assertion.
- D3 fixed `9dfd858`, except one item where the finding was wrong: `checkTurn`'s secret and number rules for a reminder are not a copy: `checkReminder` never received the message, so it was its dead `message` parameter that went. `definition()` and `TOOLS` are in `agent/tools.ts`. `stores` and `restricted` are gone (MCP undoes every store).
- D4 fixed `9beacf8`: `checkReply` moved to `core/reply-check.ts` and is one of `checkTurn`'s guards (skipped on the last turn); its verdict rides on the `reply` call to `compose`; `Shown` carries the evidence.
- D5 fixed `ee6b890`, `2b419e2`: `worker.acknowledge` sends the first signal from the webhook for each new message of an allowed sender and stamps after the call; after the stamps the lanes look again (the stamp's UPDATE locks the row for a moment and the claim skips locked rows: without this a message could wait for the sweep, which real Postgres showed). Burst test, 20 runs x 20 receipts: **receipt to stamped p50 0 ms, p95 6 ms, max 7 ms** (R7: 0, 6, 8). `signalWaiting` and `kick`'s second pass are gone.
- D6 fixed `a3f05a2`, `1b88200`. (a) Tool contracts live in the registry descriptions with `RECENT_LIMIT` and `MAX_FOUND` interpolated; the `find_movements`, `reply` and `help` bullets are out of the prompt; "goes alone" is said once, by `agent/tools.ts` for every `alone` tool; "no, eso no" once per situation. Tokens of the frozen prefix (count-tokens, free): **26,498 before, 26,443 after** (a small cut, since most of it moved). (b) Four dev scenarios (`s382` to `s385`) and two controls (`s386` a bare thanks, `s387` an exchange rate after a greeting); the old prompt failed `s383`, the new one passed 14 of 14 three times. (c) `compare`'s field description leads with `previous` and says never the whole period before as a range; `s153` passed 3 of 3 in the first check and failed once in 3 full runs (run 1 of the final set), so it is still a flake, not a 2-of-3 failure. A model flake the full runs found, `s202` sending 20:00 for "a las 8" (a silent wrong reminder), is fixed in the field description of `time` (6 of 6 clean after).
- D7 not adopted, `78460c4` and `e0b7073`: one full run with `tool_choice: any`, 356 of 365, 3 silent wrong changes and 5 unnecessary questions (D6 head: 363 to 365, 0, 0); about 80 ms faster per turn. It breaks the adoption rule, so no second and third run was spent. `results/` keeps the run.

**Docs** fixed `9ec7dda`: `AGENTS.md` rewritten for this layout and these rules; the v1-era specs are in `docs/history/` (`git mv`); the `server.ts` comment is replaced. README status and eval commands too.

**For the next builder (part 2).** MCP cleanups beyond D1 (`tools.ts` is one 500-line file), `AGENTS.md` does not yet describe the MCP tool list in detail, the SIGTERM hand-back wait (above), and `checkReminder`'s callers. `docs/rebuild/` review findings outside core, domain, agent and WhatsApp are part 2's.

### As built (R9 fixes, part 2: MCP, auth, ops scripts)

One line per item. The commands the thread runs are in `docs/runbook-cutover.md`.

- **C1** fixed: the new database is `warren_v2` inside the existing Postgres (`CREATE DATABASE`), so `.railway/railway.ts` is unchanged for it and the rollback is the old URL. The script runs `railway config plan --detailed-exit-code` first and again before the switch, and aborts on any destroy. Production's definition gained `overlapSeconds` and `drainingSeconds` (15 s); the plan for production is now exactly those two changes.
- **C2** fixed: the rollback runs `railway up <tree> --path-as-root -s warren -e <env> --ci` from the linked checkout and keeps stderr. Proven by `rollback --rehearse` on staging: `v1-final` deployed on a scratch database and probed with `--expect v1`, then the rebuild deployed with `railway up` and probed for its own deployment id. The note that the new database's later writes are not carried back is in the script and the runbook.
- **C3** fixed: `/health` answers `ok` and an `x-warren-build` header (commit sha when Railway has one, plus the deployment id, which a `railway up` has alone); v1 sent none. `pnpm probe <env> --expect <sha or id>` polls until it matches (`--expect v1`: no header). Step 9 and the rollback use it.
- **C4** fixed: the script stops the old deployment (`railway down`) and checks the newest deployment is not running and `/health` does not answer. `import-v1` reads in one `REPEATABLE READ READ ONLY` transaction and returns a snapshot per table (count, highest integer id, newest row version `xmin`, for every table of the old database, so a changed row shows too). Step 7 re-reads and aborts on any difference. Order: stop old, dump, import, verify, re-check, switch, deploy, probe. Meta retries a webhook that gets no 200 for up to 7 days (Meta's WhatsApp webhooks page), so messages sent in the gap arrive later.
- **C5** fixed: after each `copyTable`, every serial or identity column's sequence is set past its copied rows (`link_request` included); a test imports and then takes the next id.
- **C6** fixed: two md5 checks per account, one over every live movement's `direction|amount|currency|occurred_on|description|category|payment|confidence`, one over every live reminder's `what|schedule|next_due_at` (ordered by that text under `COLLATE "C"`); only match or mismatch is printed. The tamper tests swap a direction, shift a date, drop a payment and change a schedule.
- **C7** fixed: `pg_dump` takes `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` from its environment (Docker `-e NAME` copies them); `import-v1` reads `V1_DATABASE_URL` and `DATABASE_URL` (its `--from` and `--to` are gone); the cutover imports in its own process.
- **C8** fixed: `createSink` throws without a token and the sink's process passes `SINK_TOKEN`; the staging probe asserts the variable is set and that `/sent` answers 401 with no token.
- **M1** fixed: v1's bounds (200 characters for any text, 20 for an amount, a day, `from` and `to`; at most 10 words in `find_movements`'s text) in `mcp/tools.ts`, one function for the three tools that take free text. A 200 KB description is refused (test). They are not in `checkValues`, so WhatsApp and the cached prompt prefix are unchanged.
- **M2** fixed: an MCP write whose strings are `sensitive` is committed with `scrub`, so `turn.calls[].input` keeps nothing. The movement row and the `mcp_request` result keep what the call stored, as v1's and WhatsApp's do (a secret is refused before that, by `checkValues`; what passes is a description).
- **M3** fixed: the MCP block of `log_movements` has its own input with `confidence` defaulting to `high` (`McpBlock.input`); the client sees it as optional.
- **M4** fixed: our own exact check, `new URL(origin).origin` against `https://<host>` of each client host plus our origin; `http://claude.ai`, `:8443` and a look-alike host are 403 (tests). The SDK helper compares hostnames only and cannot take origins.
- **M5** partly: removed the second `try/catch` of the write path (`runTool` has the one). `tools.ts` is still about 500 lines, because the output views that its registry schemas ask for are most of it; collapsing them further would change the output schemas, which the brief excluded.
- **M6** fixed: `door.ts`, `auth/link.ts` and `auth/routes.ts` use `whatsappAddress`.
- **M7** fixed: no `waId` in `authInfo.extra`.
- **M8** fixed: `CLIENT_HOSTS` is a list of hosts; origins are `https://<host>`; `name` is gone.
- **M9** fixed: `app.ts` checks the host once (`AppOptions.publicHost`) for `/mcp` and the OAuth routes; `endpoint.ts` and `auth/routes.ts` no longer do.
- **L1** fixed: the message sweep runs every 5 s, the reminder sweep every 30 s (`server.ts`; `Warren.sweepMessages` and `sweepReminders`, `sweep` runs both). An idle message sweep (its three queries over the open rows' partial index) took 0.35 ms on `postgres:17` with 100,000 done rows.
- **L2** fixed: an undo counts its window from the message and restores a reminder from the commit clock (`undoLast` takes both); a test fails without it.
- **L3** nothing to do: no D7 result file is committed (`results/*` is ignored but `latest.md` and `v1-baseline.json`).

Proof at the last commit: `pnpm check` 996 passed, 15 skipped (PGlite); the whole suite on `postgres:17`, 1011 passed, 0 skipped; CI green on both jobs; `pnpm probe staging --expect <head>` passed (16 lines, 0 failures); `scripts/cutover.ts --dry-run` on a fresh dump of production: 17 checks match.

## Decisions (Ticiano, 2026-11-22)

1. Rebuild from scratch on main, autonomously, with no manual testing in the middle.
2. Undo keeps the strict stack, and the reply explains a block.
3. BAJA is removed, and cancelling goes through the agent (already shipped in #53).
4. The reminder template keeps the name `warren_reminder`. No `_v2`: resubmitting it once Meta lets the name go stays a pending item, outside this rebuild.
5. Spend approved: a cap of US$5 for evals and experiments, and a Railway `staging` environment (one service, one Postgres) for the length of the rebuild, deleted after cutover.
