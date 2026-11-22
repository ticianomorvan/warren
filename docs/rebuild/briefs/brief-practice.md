CURRENT-PRACTICE BRIEF for the council. Question: keep `inbound_message` as the message log, batch log, pending-question store and MCP batch record, with three per-store supersede/undo codepaths, or move to a channel-neutral turn/batch table with one effect log and one undo engine?

Method: I read the repo at 066eb87 and checked the web sources below. Two sources I could not confirm directly: the microservices.io outbox page returned only navigation text, so I cite secondary sources for outbox. pg-boss and Graphile Worker were confirmed from a partial official page and mirrors. Nothing was edited or sent. Exact quotes and numbers are limited to what the sources gave.

## 1. Undo in small apps: what current practice says

- **Event sourcing undoes by appending.** Microsoft's pattern guide says the only way to undo a change is to add a compensating event rather than edit history ([Azure Event Sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)).
- **Fowler's variants.** A wrong event is reversed and marked, then replaced by a retroactive event. "We never delete an event" ([Fowler Retroactive Event](https://martinfowler.com/eaaDev/RetroactiveEvent.html), [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)).
- **The known cost.** One CQRS thread notes that a compensating event per event type gets unwieldy. The alternative discussed is a memento of prior state plus an undo stack ([DDD/CQRS thread](https://groups.google.com/g/dddcqrs/c/odUUsOWoeJc)). This is informal and low-weight.
- **The agent-SDK analogue is crude.** OpenAI's Agents SDK session offers `pop_item()`. To undo an exchange you pop the assistant reply, then the user message, and re-ask ([OpenAI sessions](https://openai.github.io/openai-agents-python/sessions/)). That is history editing, not effect reversal.
- **Not found.** I found no authoritative source describing an "undo last action" model for a personal-finance app, or the GoF command-pattern undo.
- **Inference, not sourced:** Warren's design (append-only rows plus supersede and restore pointers) is versioned rows with compensating rows. That fits the sources, and a full event-sourced store is not required by them.

## 2. Outbox, at-most-once, idempotency keys

- **The outbox is at-least-once by construction.** The relay can publish and then crash before marking the row sent, so the row is published again ([secondary summary of microservices.io](https://microservices.io/patterns/data/transactional-outbox); [DZone](https://dzone.com/articles/implementing-the-outbox-pattern)). Consumers are advised to deduplicate.
- **Warren is not a textbook outbox.** It commits a marker before the send and never resends. That is the deliberate at-most-once inverse, and I found no source arguing against it for a single-recipient notification bot.
- **Stripe/Brandur design.** One `idempotency_keys` table holds these fields ([Brandur](https://brandur.org/idempotency-keys)):
  - the key, scoped per user;
  - a lock timestamp, so concurrent duplicates are rejected;
  - the request parameters, to detect a key reused with different input;
  - the stored response;
  - a recovery point.
- **Phases.** Work is split into "atomic phases" between foreign calls. Local state is committed "before initiating any foreign state mutation". Slow side effects go to a transactionally staged job.
- **Retention.** Keys can be pruned once at least 24 h old ([Stripe docs](https://docs.stripe.com/idempotency)). Brandur says keys are "for near-term correctness", not a permanent archive ([Brandur](https://brandur.org/idempotency-keys)).
- **Stripe v1 replays 500s.** v1 returns the saved status and body of the first request, errors included ([Stripe API](https://docs.stripe.com/api/idempotent_requests?lang=python)).

## 3. Persisting agent turns and pending questions

- **OpenAI Agents SDK sessions.** A session stores "all new items generated during the run (user input, assistant responses, tool calls, etc.)". The default SQLite store is rows keyed by `session_id`, ordered by an insertion ID, with a JSON payload. `AdvancedSQLiteSession` adds branching from a turn ([OpenAI sessions](https://openai.github.io/openai-agents-python/sessions/)). The model is an append-only item log per session, with no separate batch or effect table.
- **Vercel AI SDK.** Persistence is left to the app. Docs say to store `UIMessage[]` in the `onEnd`/`onFinish` callback ([AI SDK persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence.md)). Vercel's own Postgres example flattens message parts into rows with an order index ([ai-sdk-persistence-db](https://github.com/vercel-labs/ai-sdk-persistence-db)). A community write-up advises persisting the rich UI message, not model-level messages, to decouple storage from the LLM provider ([DEV write-up](https://forem.com/yigit-konur/vercel-ai-sdk-v5-internals-part-9-database-deep-dive-persisting-uimessages-effectively-362l)). This is a blog, so treat it as opinion.
- **Gap in the sources.** I found nothing on how any SDK persists a pending clarifying question as a first-class record. In the SDKs it is just the last assistant item plus the next user item. Warren's `pending` JSON plus `asked_ids` is custom and has no direct precedent in what I read. I could not find a multi-channel bot message model beyond these, so the "channel-neutral turn" proposal rests on general reasoning, not a source.

## 4. Postgres queues vs an in-process tick

- **Graphile Worker.** Uses `SKIP LOCKED` to find jobs and executes each at least once. It retries automatically with exponential backoff. It has a crontab-like scheduler with optional backfill ([Graphile Worker docs](https://worker.graphile.org/docs)). Its docs do not state a lock-timeout figure.
- **pg-boss.** Also built on `SKIP LOCKED`, and needs PostgreSQL 13 or newer ([pg-boss repo](https://github.com/timgit/pg-boss)). Sources overstate it as "exactly-once". `SKIP LOCKED` only covers the claim. A worker that crashes mid-job needs leases and retries ([Encore, Postgres job queue](https://encore.dev/articles/postgres-job-queue-skip-locked)).
- **When a library is advised.** Encore suggests River, pg-boss or Graphile Worker when jobs must be enqueued atomically with your own writes and volume is modest ([Encore](https://encore.dev/articles/postgres-job-queue-skip-locked)). This is a single secondary source.
- **Consequence for Warren.** A library queue is at-least-once by default, which collides with the at-most-once decision. Adopting one would mean using its claim step only and keeping the existing started-marker.

## 5. What the repo does today (all at 066eb87)

- **One table, five roles.** `inbound_message` is the message log. Its `wamid` is also the dedup key (`src/migrations/001_init.sql:6-8`). It is the batch (`undoes`, `src/migrations/009_undo.sql:9-12`), the question store (`pending`, `asked_ids`, `src/migrations/008_agent.sql:12-14`, `src/store.ts:240`), the MCP idempotency record (`channel='mcp'`, `wamid='mcp:<id>'`, `src/migrations/013_channel.sql:11`) and the at-most-once send marker (`send_started_at`, `src/migrations/002_at_most_once.sql`).
- **Batch identity is derived, not stored.** `batchRow` is "action and reply_text set, not an undo" (`src/ledger.ts:144-146`). `lastBatch` finds the batch by probing four tables with `EXISTS` (`src/ledger.ts:181-215`).
- **Three append-only stores, three copies of the same shape.** Each has its own supersede or forget stamp, `restores` pointer and `*_by` index:
  - movement: `src/ledger.ts:101-128`, `copyVersion` at `src/ledger.ts:291`;
  - fact: `src/facts.ts:123` and `src/migrations/011_facts.sql`;
  - reminder: `src/reminders/db.ts:84` and `src/migrations/014_reminders.sql:16-26`.
- **Three undo planners.** `undo.ts` orchestrates (`src/undo.ts:80-203`). It takes an advisory lock at `src/undo.ts:86`, with others at `src/facts.ts:70` and `src/reminders/db.ts:58`. Fact planning is `src/undo-facts.ts:42-72` and reminder planning is `src/undo-reminders.ts:53`.
- **Channel leaks into undo.** Reminders cannot be undone from MCP (`src/undo.ts:100-106`, `whatsapp_only`). `followForward` is a recursive walk with a 50-hop cap to decide "stale" (`src/ledger.ts:259-276`).
- **MCP idempotency is a good fit for Stripe's design.** It uses `ON CONFLICT (wamid) DO NOTHING` plus a call-hash check on replay (`src/mcp/write.ts:117-165`).
  - Match: scoped per account, different-input reuse is refused, and the first result is replayed.
  - Mismatch: the key lives in the log table with no pruning, there is no lock timestamp, and `payload` is overloaded as the result store.
- **Send and schedule.** The WhatsApp marker is committed before the send (`src/store.ts:357`). A `started` row that never ends becomes `unknown` and is never resent. Reminders have the same discipline in `reminder_send` (`unique (reminder_id, due_at)`, `src/migrations/014_reminders.sql:36-47`; stale `started` becomes `unknown` after 10 min, `src/reminders/send.ts:26`). Claims already use `FOR UPDATE SKIP LOCKED` (`src/store.ts:176`, `src/reminders/send.ts:114`, `src/reminders/send.ts:163`) under a 30 s `setInterval` tick (`src/server.ts:85`). The tick is a coarse poll but the claim pattern matches what the queue libraries do.

## Challenged decisions

None of the owner decisions is contradicted by evidence I found. In particular:
- At-most-once sends are the inverse of the outbox's guarantee, but the sources describe the outbox as a different goal, so they do not argue against it.
- The own agent loop, postgres.js and the single replica are untouched by anything here.
- No source says an in-process tick is wrong at one replica.

## Simplifications current practice allows here

1. **One effect record instead of three `restores`/`*_by` copies.** Compensating rows are what event-sourcing guidance recommends. Nothing requires per-table pointer columns. A single `effect(batch_id, kind, entity, row_id, before_row_id)` log would let one engine compute undo, replacing `src/undo.ts`, `src/undo-facts.ts` and `src/undo-reminders.ts` (about 400 lines) and the `lastBatch` four-way `EXISTS` (`src/ledger.ts:181-215`). Caveat from the sources: a compensating action per type remains. Reminders have real side effects (next date, sent count), so "restore" is not purely data. This is my inference.
2. **A real `batch` id.** Make the batch an explicit row, or a column set on write, instead of "the message with action and reply_text" (`src/ledger.ts:144`). That removes the `channel` special-casing and the `settleBatchRow` dance (`src/ledger.ts:153`). It is not an event-sourcing requirement. It is just fewer derived facts.
3. **Split the MCP idempotency record from the message log.** An `idempotency_key(account, key, request_hash, response, created_at)` table, pruned at about 24 h, matches Stripe and Brandur. It stops `inbound_message` carrying fake `wamid='mcp:...'` rows and an overloaded `payload` (`src/mcp/write.ts:124`). `lastBatch` would stop needing a `channel` filter.
4. **Keep, do not replace, the `SKIP LOCKED` sweeps.** Moving to pg-boss or Graphile Worker would not remove the started-marker code at `src/store.ts:357` and `src/reminders/send.ts`, since those queues are at-least-once. I see no sourced reason to adopt one at one replica. If one is ever adopted, use it only for claim and retry, and stage jobs in the writing transaction (Brandur's staged-job idea).
5. **Pending question as its own small record.** No SDK models this, so there is no standard to copy. It is still a separate lifecycle (10 min window, `ANSWER_WINDOW_MS`, `src/store.ts:68`), and `asked_numbers`, `asked_ids` and `pending` could move out of the log row into a `question` table keyed by turn. This is a judgement call, not sourced.
6. **A turn-level `message` log can be thinner.** Per OpenAI and Vercel, the transcript is an ordered item list (user input, assistant text, tool calls), and idempotency, undo and send state live elsewhere. Warren's `tool_calls`, `command` and `parsed` columns (`src/migrations/008_agent.sql`) are that audit, so they could be one JSON `items` column. Low value and optional.

Sources: URLs inline above.