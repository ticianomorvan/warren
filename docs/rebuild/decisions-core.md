# Council 1 — Warren core shape: decisions (2026-11-22)

Judges: Opus 5.5 and Fable 5.2, one pair per group (turn record, write path, history/undo), plus two Sonnet research briefs. Context, not verdicts: five area reviews (scratchpad/overhaul/review-*.md).
Rule: where a decision assumes Postgres, postgres.js, PGlite or Railway behaviour, the builder checks the docs or dist first. If the behaviour doesn't hold, stop that item and report; never work around it.

## Converged (decided)

- **D0 Turn table.** Add a channel-neutral `turn`. It holds the committed unit of work and is inserted only inside the commit transaction, so its existence is the commit point. Columns: `id`, `account_id NOT NULL`, `channel` (whatsapp | mcp | cli), `created_at`, `action` label, `calls` jsonb, `record`, `reply`, `question` jsonb, `undoes UNIQUE`, `CHECK (undoes <> id)`. Evidence: all 6 judges and reviewers A, C and D. Today's problems:
  - batches are found through `wa_id` joins (ledger.ts:188-190);
  - MCP writes fake WhatsApp messages (mcp/write.ts:117-127);
  - 7 queries filter `channel='whatsapp'`.
- **D1 `inbound_message` becomes WhatsApp transport only.**
  - It keeps the raw log, dedupe, claim and queue state, send markers (typing, interim, failure, send_started, reply_sent), agent trace and timings.
  - It gains `turn_id` UNIQUE.
  - Delete:
    - `channel` and its filters;
    - the MCP rows;
    - `batchRow` and `settleBatchRow` (ledger.ts:137-175);
    - `asked_numbers`, `asked_ids` and `pending`;
    - `updated_at`;
    - `parsed`;
    - `payload` reuse.

  The judges were 2 of 2 for keeping send markers on the row, so there is no separate outbound table. The `reply` table and `reminder_send` stay as status sinks.
- **D2 MCP requests.** Store them in `mcp_request(account_id, request_id, input_hash, turn_id, result jsonb, created_at)`, primary key `(account_id, request_id)`. Replay semantics stay as they are. `waId` stops being threaded through the door, the tool context and the write request.
- **D3 One lock per account.** Every write transaction (`store.commit`, `writeAsMcp`, cli) starts with `SELECT 1 FROM account WHERE id=$1 FOR NO KEY UPDATE`. It is taken after the WhatsApp guard row.
  - Delete advisory keys 7203002, 7203003 and 7203005, plus `lockFacts`, `lockReminders` and `lockRows`.
  - The reminder sweep keeps its row locks with SKIP LOCKED and never takes the account lock.
  - Evidence: all 6 judges; the lock-order hazard (facts or reminders lock versus undo's row locks).
- **D4 Uniform history.** Movement, fact and reminder each get `entity_id` (stable across versions), `made_in` (references turn), `ended_in` (references turn) and `ended_at`, plus a CHECK pair and `UNIQUE (entity_id) WHERE ended_at IS NULL`. Live means `ended_at IS NULL` everywhere.
  - Delete:
    - `superseded_by`, `deleted_by`, `forgotten_by`, `cancelled_by` and `restores`, with their indexes;
    - the three `LIVE` constants and `sql.unsafe(LIVE)`;
    - the facts nextval and DEFERRABLE-FK trick;
    - copying `created_at` onto the new row by UPDATE.
  - Corrections and restores insert a new version with the same `entity_id`, passing `logged_at` in the INSERT.
  - Reminder scheduler state (`next_due_at`) stays mutable on the row as declared operational state.
  - Evidence: write-path Opus, write-path Fable, history Opus, reviewer C. History Fable proposed current-state rows plus a jsonb effect log instead (see D9).
- **D5 One undo engine** over uniform versions (`src/undo.ts`). An effect is derived from the rows: a version made in the turn, and a version ended in the turn, grouped by `(store, entity_id)`.
  - It is stale when the entity's live version is not the one the turn left.
  - Store hooks cover the reminder rules: a sent one-off, an occurrence left, the cap, recomputing `next_due_at`. Caps also apply when facts are restored (MAX_FACTS).
  - Channel policy is passed in as a `stores` argument, not read from inside the engine (`whatsapp_only` goes).
  - Delete:
    - `undo-facts.ts` and `undo-reminders.ts`;
    - `followForward`, `settledBatches` and `headOf`;
    - `effectsOf` and `batchRows`/`Facts`/`Reminders`;
    - the four-way EXISTS in `lastBatch`.

  `lastBatch` becomes: newest turn of the account, not an undo, not undone, with at least one effect.
- **D6 Stable ids exposed.** The model and MCP clients see `entity_id`, which stays the same across corrections. The guard "ids shown" works on `entity_id`, and staleness is checked at write time against the live version. This is the groundwork for card statements and budgets that refer to a movement.
- **D7 Undo order is commit order** (turn id) under the account lock, replacing arrival order (`i.id < cur.id`). They differ only when channels overlap within seconds.
- **D8 One write path.** `applyCall(tx, ctx:{accountId, turnId, now}, call: WriteCall) → Outcome` covers all nine writes:
  - log, correct and delete movements;
  - undo_last;
  - remember and forget a fact, and forget_all_confirmed;
  - set and cancel a reminder.

  Outcomes share one status vocabulary and carry `effect` (logged, corrected, deleted, undone, remembered, forgotten, reminded, unreminded).
  - Delete:
    - `applyReminderCall`, `ReminderCall` and `ReminderOutcome`;
    - `WRITE_TOOLS` (a dead export, apply.ts:39);
    - `CHANGES` and `KIND_OF_TOOL`;
    - `action-label.ts` (its label moves into the tool registry, see council 2).

  The cli writes through it with `channel='cli'`.
- **D10 Drop bookkeeping nobody reads.** Delete `movement.position` with its UNIQUE, `ApplyContext.position`, `Outcome.rows` and `reminder.sent_count`.
- **D11 WhatsApp worker ordering.**
  - `kick(senders)` claims the oldest due rows of those senders. A claim takes a row only when no older open, uncommitted, not-stale row of the same sender exists.
  - Claims run in id order. The sweep runs senders in parallel. Housekeeping UPDATEs run only in the sweep.
  - Evidence: the deploy hand-off hole (process.ts:412 and store.ts:153).
- **D12 Code answers as one pure function:** `resolve.codeAnswer(text, {question, typed, signIn})`, with a shared `words()` helper.
- **D13 Split `process.ts` along the channel seam.**
  - `src/understand.ts`: context and agent → actions.
  - `src/whatsapp/worker.ts`: claim, lanes, typing, interim, deadline, deliver, shutdown.
  - Media helpers move next to `graph.ts`.
  - No Channel interface until a second chat channel exists.
- **D14 Small deletions:**
  - `defaultClient` (the client becomes required);
  - the store pass-throughs;
  - the synthetic MCP audit and `model_turns=0`;
  - `payload = payload`.
- **D15 Railway draining.** Set draining time (about 15 s) and overlap in `.railway/railway.ts`. Neither is set today, and the default draining of 0 s means the 10 s graceful stop never runs. Verify both in Railway's docs.
- **D16 One migration.** `016_turn_history.sql` is one-way: take a `pg_dump` backup first and keep `legacy_*` copies of the old tables. Batches committed before the cutover cannot be undone, so deploy at a quiet hour. The live data is 1 person, about 100 messages and a few facts and reminders.

## Split → decided by me

- **D9 Uniform version rows plus a derived view, rather than current rows plus a jsonb effect log** (3 of 4 judges). It keeps AGENTS.md rule 3 as written ("no value is edited"), keeps typed columns and adds no second source of truth. Reconsider only if privacy pruning (erasing forgotten values) becomes a requirement.
- **Keep `tsx`** (reviewer E). Node type stripping would mean churn across every import for a small payoff (reviewer A disagreed).
- **Keep the `request_id` idempotency** (2 of 2 judges keep it). It is cheap in its own table.
- **A failed message between a question and its answer still closes the question,** as today (2 of 2 judges).
- **MCP undo of reminder batches is allowed** once MCP has reminder tools. Its result names what came back, and BAJA no longer exists.

## Answered by Ticiano (2026-11-22)

- **Q1 Undo blocked by a batch that can never be undone: keep the strict stack.** The reply says why, and suggests fixing the older thing directly ("corregí el café…").

## Deferred

- Erasing a forgotten fact's value after 24 h (privacy).
- Per-client MCP revocation.
- A Channel interface.
- An outbound table.

## Proof bar

- `pnpm test` on PGlite, plus the whole suite on real Postgres (it also runs in CI after the tests slice).
- `migrations.test.ts` covering 016 over data in every state.
- The scenario eval at its bars (≥95% fully right, 0 silent wrong changes, 0 invented numbers) for 3 runs.
- A live probe: WhatsApp log, correct, undo; an MCP write then a WhatsApp undo; a reminder fires.
- A fresh-context Opus review (`/code-review` high and `review-design`).
