# Warren

Warren is a WhatsApp expense agent for people in Argentina. A person writes "café 3500 y súper
12.000 con la visa, ayer 20 lucas de nafta" and gets one compact reply listing what was
understood. They fix it in plain words ("no, el café fue 3800", "borrá el último") and ask simple
questions ("¿cuánto gasté este mes en super?"). The spec, with its slices and the Slice 1 result,
is in `docs/spec.md`. The previous mail-ledger product is the tag `v0-mail-ledger`.

## Rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** A model never adds, converts or rounds money. Amounts are
   decimal strings ("3500", "1500000.50"); code computes every total.
2. **The model acts only through guarded tools.** A short agent loop (at most 3 model turns) calls typed
   tools; the write tools are terminal: code validates them, runs them inside the commit point and renders
   the reply from a template, with no further model turn. The model never writes a reply and never picks a
   target in code's place: an id it sends must be one it was shown, the sender's, and live.
3. **Corrections never overwrite a movement, deletes never remove one.** A correction is a new row
   that supersedes the old one (`superseded_by`); a delete stamps `deleted_at` and `deleted_by`. Only
   movements that are neither count (the recent list, query totals).
4. **Secrets live only in the gitignored `.env`.** Never in code, logs, eval output or commits.

## Layout

```
src/agent/    The agent: schema.ts (tool inputs, categories, periods), tools.ts (the strict tool list, frozen),
              prompt.ts (frozen system prompt + the per-message context), calls.ts (the guards that need no
              database), loop.ts (the manual loop, warm-up), validate.ts (the value rules), models.ts
              (Haiku/Sonnet configs, prices), index.ts
src/time.ts   The Argentine calendar day and clock, and the date range of a summary period
src/server.ts Entry point: config, migrate, warm-up, startup sweep, 30 s sweep, HTTP server (`pnpm start`)
src/app.ts    node:http routes: GET /health, GET+POST /webhook (signature, dedupe, persist, 200)
src/store.ts  The rules of the tables (inbound_message, reply, account): due predicate, claim, the
              conversation window, the commit transaction (guard, then the actions' effects, then the stored
              reply and the audit), ownership-guarded writes
src/ledger.ts All SQL on `movement`: live movements (not superseded, not deleted), find, insert, lock,
              supersede, soft delete, summary totals
src/movement.ts Pure: text normalizing, applying a correction's changes, which fields changed
src/resolve.ts  Pure: `answerNumber`/`answerAction`, the bare answer to a question we asked (done in code)
src/execute.ts  Runs a message's actions inside the commit transaction and returns the reply to store
src/process.ts  Per message: ignored vs reply; for text, typing + agent together, the 10 s interim note, the 30 s
              deadline, the commit point, the at-most-once send; drain on shutdown; the sweep
src/render.ts The reply templates (Argentine money format) and every canned text; pure
src/test-harness.ts  Shared integration-test setup: PGlite (or a real Postgres), fake Graph, fake Anthropic client
              (scripted tool calls), `setup()`
src/command-fixtures.ts  Scripted tool calls, seeded movements and `say()` for the agent tests
src/http.ts   keepAliveFetch: a fetch with its own 60 s keep-alive pool (Graph and Anthropic)
src/whatsapp/ signature.ts (HMAC), payload.ts (Zod parse of webhooks), graph.ts (Graph API client)
src/config.ts Zod-validated env; src/db.ts postgres.js + migrations; src/log.ts JSON logs
src/migrations/  Plain SQL, `NNN_name.sql`, applied once at startup under an advisory lock
src/latency.ts  `pnpm latency` report, by action
evals/        cases.jsonl (dev/test split, one command per message), command.ts (that command shape), agent.ts
              (runs the agent on a case and maps it to a command), grade.ts, run.ts, results/ (gitignored but summary.md)
evals/scenarios/  Multi-turn scenario eval: scenarios.jsonl, schema.ts, grade.ts (database-state grading), drive.ts (plays a scenario through the real pipeline), report.ts, run.ts, results/baseline.md
docs/spec.md  Source of truth for what is built and in which order; docs/agent-spec.md the agent design
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome
pnpm typecheck
pnpm test          # Vitest, no network; real SQL on in-process PGlite, Graph API injected
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres pnpm test src/concurrency.test.ts
                   # also runs the real-Postgres concurrency tests (skipped without PG_TEST_URL; CI never sets it).
                   # Throwaway database only, it is truncated. docker run --rm -d --name warren-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17
pnpm start         # the server; needs DATABASE_URL, ANTHROPIC_API_KEY and the WhatsApp variables (see src/config.ts)
pnpm latency [--last N]   # p50/p95 per stage, model time, log-only reply time, from DATABASE_URL (Railway: the Postgres public URL)
pnpm eval [--model haiku|sonnet] [--split dev|test|all] [--concurrency N]   # one message at a time through the agent, needs .env
pnpm eval:scenarios [--split dev|test|all] [--budget 0.30] [--only s001,s002]   # multi-turn scenarios, real pipeline and model, needs .env
```

`pnpm eval` spends money: tune the prompt on `--split dev` only and run `--split test` once per
model at the end. CI never calls the Anthropic API. Its cases are written as one command per message
(`evals/command.ts`); `evals/agent.ts` runs the agent on each and maps what it did into that shape (an
`ask_user` is a low-confidence command). The 5 cases that are only the pick of an option of a question
(`answeredByCode`) are code's job and are covered by unit tests, not measured on the model.

`pnpm eval:scenarios` does the same for conversations (PGlite, a fake Graph, the real model; stops before its
`--budget`, default US$0.30). It grades the database after each turn and gates on 95% fully right and 0 silent
wrong changes. Its test split is held out like the other: never print or tune on it. Baseline:
`evals/scenarios/results/baseline.md`.

## Conventions

- Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional
  Commit (`feat:`, `fix:`, `docs:`, `chore:` ...). Every commit is signed off: `git commit -s`.
  See `CONTRIBUTING.md`.
- Pin GitHub Actions by full commit SHA with a version comment; workflows default to
  `permissions: contents: read`. Never use `pull_request_target` with a checkout of the pull
  request.
- pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside
  `allowBuilds` (`pnpm-workspace.yaml`). Do not widen either without a reason in the commit.
- Node 24 (`.nvmrc`), TypeScript strict, Biome formatting, Zod 4 for schemas.

## Deploy

- Railway project `warren` (US East, Virginia: `us-east4-eqdc4a`), services `warren` (the app) and
  `Postgres`. Deploy by hand with `railway up -s warren` from the repo; there is no GitHub integration yet.
- Railway settings live in `.railway/railway.ts` (Infrastructure as Code, npm `railway` SDK): build, start
  `pnpm start`, healthcheck `/health` (60 s), restart on failure, 1 replica in US East, the domain, and the
  Postgres TCP proxy. Variables are unmanaged, so the file never holds secrets; set them with
  `railway variables`. Change the file, run `railway config plan`, then `railway config apply`. A plan that
  is not "already up to date" means someone changed the service by hand.
- **Single replica, single process.** The recovery sweep and the in-process worker assume it. The atomic
  claim stops a double send, but do not scale out without revisiting the sweep.
- The app reaches Postgres on the private network (`DATABASE_URL=${{Postgres.DATABASE_URL}}`). For
  `pnpm latency` from a laptop, build the URL from the Postgres service's `RAILWAY_TCP_PROXY_*` and `PG*`
  variables (a TCP proxy is enabled on that service). Never print it.
- Webhook host `wa.heywarren.app` (CNAME and TXT in Vercel DNS). The Meta subscription is set by API
  (`/{app-id}/subscriptions`, `/{waba-id}/subscribed_apps`), not in the dashboard.
- `ALLOWED_WA_IDS` (comma-separated, `+` and spaces ignored) is who gets a reply. `*` answers everyone (dev
  mode); empty or unset answers nobody. Every message is stored; the others end as `ignored`.
- **Meta test number:** it only delivers to its recipient list, matched exactly. Meta saves Argentine
  mobiles there without the `9` (and Mexican ones without the `1`), even when typed with it, while
  webhooks give `549…` / `521…`. `sendText` in `src/whatsapp/graph.ts` sends to the `wa_id` and, only
  after a 131030 (nothing was sent), retries once with the short form and remembers it for that number. A list entry typed with the local `15` is saved with it and
  never matches; re-add the number as `+54 9 <area> <number>`. The symptom is `131030 Recipient phone number
  not in allowed list` on every send while read and typing still work.
- Sends are at most once. `send_started_at` is committed before the Graph call; a row that dies after that
  (timeout, 5xx, killed worker) ends as `unknown` and is never sent again. Only an HTTP 4xx answer, which
  proves nothing was sent, goes back to `pending` (retryable codes) or `failed` (permanent codes).
- **Message flow (slices 3, 4 and agent B).** A text message from an allowed sender runs the read receipt plus
  typing and the agent together. Deadlines count from `received_at` and are processor options (`interimMs` 10 s,
  `deadlineMs` 30 s). The commit point is one transaction (`store.commit`): the actions' effects, the movements (unique on
  `(inbound_message_id, position)`, counted across the whole message), the stored `reply_text` and the audit.
  Before it, a failed agent run (a model error, no valid action in 3 turns) or the deadline ends the message
  `failed` with one failure notice (`failure_sent_at`, committed before the send) and a late model result
  writes nothing. After it, the stored reply is sent even if late,
  and the sweep sends it without calling the model. The interim note (`interim_sent_at`) and the failure notice are committed before they are sent and never repeated. There is no done mark (a ✅ reaction was removed 2026-11-21). A tool call with an unstorable
  value (bad amount, date or description) is never repaired: the loop answers it with the reason and the
  model gets another turn; a model that cannot fix it within 3 turns fails the message.
- Optional `HELP_CONTACT` adds a human contact line to the help reply; unset adds nothing.
- **Shutdown.** On SIGTERM `processor.stop()` aborts agent runs that have not reached the commit point and settles
  those rows to `pending`, so the next process's startup sweep answers them inside their deadline. The deadline
  is one `AbortSignal` checked right before the commit; a deadline that fires mid-commit loses (committed
  means the reply goes out). `today` comes from the message's own time (`meta_ts`), not the clock.
- **The agent (slice B; `docs/agent-spec.md`, Slice B notes).** `src/agent/loop.ts` is a manual loop on
  `client.messages.create` (Haiku 5.5, effort low, thinking off, strict tools, a frozen system prompt and tool
  list under one cache breakpoint; `usage.cache_read_input_tokens` is logged at every commit). The volatile
  context comes after the breakpoint: the Argentine date and time, a 14-day calendar, the 10 newest live
  movements with position, **id** and logged time, the conversation window (the sender's committed turns of the
  last 30 minutes, at most 6, from `inbound_message.body` and `reply_text`) and, within 10 minutes, the
  question Warren just asked with the id behind each option. Tools:
  - `find_movements` (read): the sender's whole history, by text, dates, category, payment, amount; at most 20
    rows with ids. Its results go back in one user message (parallel calls included).
  - Terminal, run by code at the commit point in the order given, in one transaction, one combined reply:
    `log_movements`, `correct_movement`, `delete_movement`, `summarize` (today's periods and filters),
    `ask_user` (a short phrase plus the movements to offer, newest first, numbered 1..k by code; it stores
    `asked_numbers`, `asked_ids` and `pending`, what choosing an option will do), `reply` (help, off_topic,
    smalltalk, nothing_logged: canned).
  - Guards, in code: an id must have been shown to the model in this message (list, find result or pending
    question) and, at the commit, belong to the sender and be live (`lockLive`, `FOR UPDATE`), else that action's
    line is "ya fue corregido o borrado" and the others still run; amounts are decimal strings, dates real and
    not in the future (a refusal is answered to the model, not repaired); at most 10 movements per message; an
    empty correction is refused; an `ask_user` question longer than a short phrase or with a digit or `$` in it
    is replaced; the model never computes a total; the cap is 3 model turns and a text-only answer costs one;
    the deadline signal is on every call; a failure or the deadline writes nothing.
  - **A bare answer to our question is code's job.** If the previous message got an `ask_user` with a pending
    action, at most 10 minutes ago, and the new message is only an answer (`answerNumber`: "2", "el primero",
    "sí" after one option), `answerAction` runs the pending correction or delete on the id that option offered
    and no model is called. Anything with more in it ("el 2 fue 4500") goes to the model, which sees the options.
  - A correction is a new row (`superseded_by`), a delete stamps `deleted_at`/`deleted_by`; every correction or
    delete reply shows before and after, and the logged time (and the day, if not today) when the movement is
    not the newest.
  - Stored on the message: `parsed` what the model asked for (null when no model ran), `command` what ran (both
    lists of `{tool, input}`), `action` (log, correct, delete, summarize, ask, reply, multi), `tool_calls` the
    audit (every call with turn, input, outcome, ms), `model_turns`, `model_ms`.
- **Weeks, periods and queries.** Weeks are Monday to Sunday and whole, so `this_week` can end after today; months
  and years are calendar ones; all ranges are Argentine days (`periodRange`, from the message's own time).
  Summary totals are `sum()` in SQL, grouped by direction and currency, never converted; the payment filter is
  accent- and case-insensitive contains (`translate`, no `unaccent` extension). `supermercado` reads as "Súper".
  Changing `tools.ts`, `schema.ts` or `prompt.ts` means rerunning `pnpm eval` and `pnpm eval:scenarios` (dev
  first). The first request after a tool-schema change compiles the strict-tool grammar (~10 s): the server
  sends one tiny warm-up request at startup.
