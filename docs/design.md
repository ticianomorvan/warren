# How Warren works, and why

Rules and layout are in [`AGENTS.md`](../AGENTS.md). This file says how the parts fit and why they are shaped so. History is in git.

## Shape

One core, two channels (WhatsApp, MCP). Every unit of work, on any channel, is one `turn` and goes through one write path, one undo
engine and one tool registry. There is no Channel interface: add one when a second chat channel exists.

Settled choices, each measured or argued once. Do not reopen without new evidence:

- No agent framework, no Drizzle, no queue library, no hosted auth. Postgres constraints, zod, the SDKs and better-auth do the work.
- The agent model is Haiku 5.5 at effort low, thinking off, non-strict tools. Strict tools cost 0.2 to 0.3 s a call and were never
  a correctness guard, because code checks every input.
- `tool_choice: any` was measured twice. It was 80 ms faster and gave 3 silent wrong changes and 5 unnecessary questions in a full
  run. Not adopted.
- Resolving a write's target in code by matching text ("match" targeting) is rejected: one wrong hit is a silent wrong change.
- The "BAJA" opt-out keyword is gone. Cancelling a reminder is an ordinary request through the agent, with the usual guards and undo.

## Data

- `account` is the person. `account_address(channel, address)` holds the WhatsApp id (unique per channel and address).
- `turn` is the committed unit of work: `account_id`, `channel` (whatsapp | mcp | cli), `label`, `calls`, `record`, `reply`,
  `question {options:[{n,id}], then}`, `undoes`. It is inserted last, inside the commit transaction, so its existence is the commit
  point. Undo order is turn id order.
- `wa_message` is WhatsApp transport only: dedupe by `wamid`, queue state, send markers, `turn_id`, `audit`, `timings`. It keeps no raw
  payload. `reply` and `reminder_send` are status sinks. `mcp_request(account_id, request_id)` makes an MCP write idempotent.
- `movement`, `fact` and `reminder` are versioned the same way: `entity_id` (stable across versions), `made_in`, `ended_in`,
  `ended_at`, and one live version per entity (`UNIQUE (entity_id) WHERE ended_at IS NULL`). Live means `ended_at IS NULL`. The model
  and MCP see `entity_id`.
- The `append_only()` trigger enforces it: no delete; only `ended_*` (once) and, on a live reminder, `next_due_at` change in place.
  It is an AFTER ROW trigger because a BEFORE trigger does not see the generated `movement.search` column.
- `made_in` and `ended_in` are `DEFERRABLE INITIALLY DEFERRED`. `applyCall` needs the turn id before the turn row exists. `commit`
  reserves the id with `nextval` after the account lock, so one account's turn ids follow commit order. A transaction that never
  inserts its turn cannot commit a version.
- Every write transaction takes one lock first: `SELECT 1 FROM account WHERE id=$1 FOR NO KEY UPDATE`. The only advisory locks are
  the migration runner (7203001) and sign-in (7203004). The reminder sweep uses `SKIP LOCKED` row locks and never the account lock.
- `amount` has `CHECK (scale(amount) <= 2)`. `movement.search` is a generated, accent-folded column that searches use.
- When an `ORDER BY` follows `SELECT entity_id AS id, id AS version`, the output name wins. Order by the qualified column
  (`movement.id`).
- A turn's `created_at` and every new entity's `logged_at` are the message's own time, not the database clock. The undo window and
  the conversation window are then deterministic. `commit` also takes a clock read at the commit point for scheduling.

## Core

- `commands.ts` is a registry of data only: input (zod), description, kind (read | write | answer | ask), effect, label, `alone`,
  typed examples, and an optional `mcp` block. The agent tools, MCP tools, labels and the prompt's tool list all derive from it.
  Guards, apply and describe are exhaustive switches over it.
- Guards run twice. `checkValues` (shared with MCP) holds the value rules. `checkTurn` holds the conversation rules: ids shown, facts
  in the person's words, `alone` tools. Declines are typed (`secret`, `contact`, `reminder_past`, `reminder_far`), so redaction keys on
  the code, never on reply text.
- `applyCall(tx, ctx, call) -> Outcome` is the one write path for the nine writes. An Outcome has a tool, one closed `status` and an
  `effect`. `describe` renders it to Spanish for both channels.
- Writes happen at the commit point only. Reads in a turn (totals, lists, question options) are rendered inside the commit
  transaction after the writes, so "café 2800, ¿cuánto llevo hoy?" sees the café.
- A fired one-off reminder ends as `next_due_at = NULL`, not as an ended version. An ended version needs a turn, and the sweep has
  none. The undo reads a live reminder with no `next_due_at` as "already sent".
- Undo derives effects from versions: per entity, what the turn ended and what it made. A turn's own intermediate versions are
  ignored. An effect is stale when the entity is not as the turn left it. Versions made by an undone turn or by an undo do not count.
- Undo is a strict stack in commit order, across channels. A change that can never be undone (a one-off already sent, no occurrence
  left, a cap) blocks the older ones. The reply names it and says to fix the older change directly. This was Ticiano's decision.
  Undo is all or nothing, within 24 hours, and reminders and facts are undone like movements.
- The reply says what a turn did from the outcomes; `describe.ts` is the only place that turns an outcome into words. A reminder is
  shown from its typed schedule, never from the model's words.

## Agent

- A manual loop of at most 3 model turns. It checks each call, runs reads, holds writes while a read is pending, and runs a turn
  whole or not at all. Nothing is written before the commit. A `stop_reason: refusal` goes to the failure path with its category and
  is not retried. Each call has a timeout inside the deadline.
- Code renders every record, total, list, question and refusal. Free text exists only in `reply`, which goes alone and passes
  `reply-check.ts`: no number code did not give, no claim of a change that was not made. A reply that fails goes back to the model
  once with the reason; the last turn falls back to a fixed line. A typed `skip {part, reason}` covers parts not done.
- Action tools have no `text` field. In stored runs 7% of calls used it and most only restated the record.
- Summaries take a typed `Range` and `compare: previous | Range`. Reminders take a typed `first`, and a pure `resolveFirst` does
  the clock arithmetic, so no word check reads the message.
- Context: one `Shown` value feeds the context text, the ids the guards accept and the numbers evidence. It holds the 10 newest
  movements, the facts the message names, live reminders, the conversation window across channels (including Claude's writes and
  "⏰ Recordatorio" sends, so "cancelá este" works) and the open question. Person data is clipped and escaped.
- Over WhatsApp a call targets the version the model was shown. Code attaches it, never the model. If the movement changed
  meanwhile, the answer is "gone" instead of changing its new form. MCP clients always see the live state, so MCP calls are
  entity-only.
- Pre-search is retrieval only. Older live movements whose words (4+ letters, at a word start) or amount appear in the message are
  added to the context, at most 8. The model still picks the id. It cut second model turns by about 74% with no silent wrong change.
- The prompt is hand-written policy prose. Tool contracts live once, in the registry descriptions. Examples are typed data. The
  tools plus system prompt are one frozen prefix with a 1 h cache (the cache is shared by every person). Volatile context is the
  first user turn. A 5 min TTL misses on most messages; the 1 h TTL pays whenever gaps are 5 to 60 min.
- A model call is a fixed cost of about 0.8 to 1.2 s and output tokens are nearly free (about 2 ms each), so do not shrink schemas
  for speed. The second model turn is the cost to watch.
- A voice note is transcribed with `whisper-large-v3` through OpenRouter, pinned to Groq (other providers heard words wrong). A
  confidence gate on the segments (mean logprob, compression ratio, no-speech probability) refuses noise. A refusal costs one
  retyped message, so thresholds lean strict. Re-measure on new notes before widening. A voice note is never the bare answer to a
  question, and code never deletes or corrects on what a speech model thought it heard. No audio bytes are stored.

## WhatsApp

- The webhook verifies the signature, stores the message (`pending`), answers 200 and sends the first signal (read and typing) for
  each new message of an allowed sender. Under a second matters most, and Warren never goes silent.
- A lane per sender claims the oldest due row, only when no older open, uncommitted, not-stale row of that sender exists. The claim is
  one statement with `FOR UPDATE SKIP LOCKED`. The queue (`queue.ts`) owns what holds a sender back: only a kind that goes through
  the agent. A sticker or a reaction never holds the next message.
- The message sweep runs every 5 s and the reminder sweep every 30 s. An idle message sweep takes under 1 ms. Housekeeping (rows
  `unknown` after a send started, `failed` after the attempts) runs only in the sweep.
- Send is stamp-then-send: `send_started_at` is committed before the Graph call. Only a 4xx proves nothing was sent. A 5xx or timeout
  ends `unknown` and is never resent. Replies of one sender go out in order.
- `commit` uses the message's `meta_ts` as its time, so a delayed turn is never stamped after the next message and lost from the
  window.
- `resolve.codeAnswer` answers without a model: option numbers, "sí" to a question, "deshacer", sign-in codes. A model-side "no" or
  "volvé atrás" with a question open answers that question. A bare number with no question open is `help`; "borrá el 2" is a position.
- A message that has a secret loses its text (`[dato sensible, no guardado]`), and so do the audit and the turn's inputs.
- One replica. The old instance of a deploy never has its row overtaken by the new one's. Draining and overlap are 15 s.

## Reminders

- A schedule is typed fields (the useful subset of iCalendar RRULE), not a rule string and not the `rrule` package: `start`, `time`
  (default 09:00), `every` (day | week | month | year) with `interval`, `weekdays`, `month_days` (or -1), `nth` weekday, `month`, and
  `until` or `count`. `nextOccurrence` is the only logic. Argentina is UTC-3 with no DST. A day 31 in a short month lands on its last
  day. `normalizeSchedule` makes defaults explicit and moves `start` to the first future occurrence before applying `count`.
- Guards: the first occurrence exists and is at most 366 days out; a time of today that has passed is refused (`reminder_past`), never
  moved to tomorrow; the text holds no secret value (a value, not the word) or contact data; at most 20 live reminders.
- The sender claims one reminder per transaction (`SKIP LOCKED`). `reminder_send` is unique on `(reminder_entity_id, due_at)`, which
  is the at-most-once marker. After downtime only the latest missed occurrence is sent, with "(era para …)" if over 15 min late.
- Inside 23 h of the person's last message (`COALESCE(meta_ts, received_at)`) it sends text. Outside, it sends the template
  `REMINDER_TEMPLATE` (`warren_reminder`, `es_AR`, utility). Unset, no template is ever sent. Error 131047 is mostly a later `failed`
  status, which turns the row into `retry_template`, claimed once. A 4xx other than 131047 spends the occurrence as `failed`.
- A person gets at most 10 sends in a rolling 24 h; over that, nothing is sent. More than 200 sends in a day raises an alert.
- No model call at fire time: the text is fixed when the reminder is set. Meta bills templates, and since 2026-10-01 only the first
  1,000 free-form messages a month are free, so text goes first. If Meta re-files the template as marketing, stop and ask.
- Rejected: a cron service, pg-boss or BullMQ (a second unit for a tick we already run), and always sending the template.

## MCP and auth

- better-auth with its `jwt`, `mcp` and `cimd` plugins, over Kysely. The MCP SDK only checks tokens. Clients are CIMD only (no
  dynamic registration), and client-id hosts are allowed only from `mcp/clients.ts`. Tokens are 15 min JWTs with `aud` = the MCP
  URL; refresh tokens rotate. The tables are plain SQL in `002_auth.sql`; `test/migrations.test.ts` fails on drift.
- Sign-in is by WhatsApp code, with no email and no outbound template. `/sign-in` shows a 6-character code and a `wa.me` link. The
  person sends `vincular <code>`, Warren asks "¿Conectar Claude…? sí/no", and only the very next bare "sí" confirms. The page then
  asks "¿Es la tuya?" and only that click finishes it. Unknown or expired codes get one neutral refusal. A code someone else asked you
  to send still needs your own "sí". Rejected: Warren sending an OTP, which needs a paid template outside the window.
- The door (`door.ts`) is authentication only: signature, issuer, audience, expiry, `typ: at+jwt`, `azp`, a user that stands for an
  account, and that account's number still allowed. Every refusal is one 401. A database that cannot answer is a 503. Scope is each
  tool's (`ledger:read`, `ledger:write`). OAuth and MCP answer only on `PUBLIC_URL`'s host.
- Origin is checked exactly (`new URL(origin).origin` against the allowed hosts), because the SDK helper compares hostnames only.
- Tools come from the registry entries with an `mcp` block, named `warren_<tool>`, plus `request_id`, `limit`, `cursor`. Writes go
  through `checkValues` then `commit`, with the same lock, so MCP and WhatsApp are one stack. A call that changes nothing leaves no
  turn and no `mcp_request` row, so the id can be reused. The same `request_id` with the same input replays the first answer.
- Free text is bounded to 200 characters, and `find_movements` text to 10 words, in `mcp/tools.ts`.
- "desconectar" on WhatsApp is code-only, with no model call. It revokes the account's tokens and consents inside the commit
  transaction; the door refuses a token issued before it.
- Not exposed over MCP: `forget_all` (needs the person's own "sí" on WhatsApp), `ask_user`, `reply`, `help`. A single `ask_user` over
  MCP makes no sense: the client agent is the agent.

## Tests and evals

- Layers: pure tables; contract tests on the database (`apply`, `history`, `turn`); one thin test per channel path; race tests;
  scenarios end to end. Tests use `useDatabase()` (a schema per file on `PG_TEST_URL`, PGlite otherwise). Waits use `until()`.
- CI has two jobs: `check` (PGlite) and `postgres` (the whole suite on `postgres:17`, where the race tests run). A race change needs
  both, many times (`RACE_RUNS`).
- Golden tests pin the Spanish strings code renders. Property tests pin the schedule.
- The scenario eval runs conversations through the real pipeline and model. The `test` split is held out: never print or tune on it.
  The bar for a change to the agent, over 3 full runs: at least 95% fully right, 0 silent wrong changes and 0 invented numbers.
  `pnpm eval:report` is the only writer of `results/latest.md`.
- Grading expectations describe intended behaviour, not what the pipeline does. A new class of failure gets dev scenarios of both
  classes before a prompt change. Do not mirror a prompt example in a held-out scenario.

## Ops

- Railway settings are code (`.railway/railway.ts`). The app is one replica with a 15 s drain and overlap. See `AGENTS.md` for the rest.
- `pnpm probe staging|production`: staging sends signed webhooks through a `graph-sink` that records sends (so it never messages a
  real phone), makes MCP calls with a minted token, and lets a reminder fire once. Production is read-only (health, handshake,
  MCP 401 and metadata, discovery). Steps assert on the sink and on a read-only database connection.
- `--expect <sha or id>` waits until `/health` names that build, in the `x-warren-build` header. It needs 3 matching answers in a row,
  a second apart, because Railway's edge briefly answered 404 right after a new build first answered.
