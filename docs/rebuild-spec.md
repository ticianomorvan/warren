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

## Decisions (Ticiano, 2026-11-22)

1. Rebuild from scratch on main, autonomously, with no manual testing in the middle.
2. Undo keeps the strict stack, and the reply explains a block.
3. BAJA is removed, and cancelling goes through the agent (already shipped in #53).
4. The reminder template keeps the name `warren_reminder`. No `_v2`: resubmitting it once Meta lets the name go stays a pending item, outside this rebuild.
5. Spend approved: a cap of US$5 for evals and experiments, and a Railway `staging` environment (one service, one Postgres) for the length of the rebuild, deleted after cutover.
