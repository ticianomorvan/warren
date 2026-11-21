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
2. **The model is a parser.** One LLM call returns one typed command (`log`, `correct`, `delete`,
   `query`, `help`, `off_topic`). Code validates and executes it and renders the reply from a
   template. No agent loop, no free-form model replies.
3. **Corrections never overwrite a movement, deletes never remove one.** A correction is a new row
   that supersedes the old one (`superseded_by`); a delete stamps `deleted_at` and `deleted_by`. Only
   movements that are neither count (the recent list, query totals).
4. **Secrets live only in the gitignored `.env`.** Never in code, logs, eval output or commits.

## Layout

```
src/parse/    parseMessage: schema.ts (command), prompt.ts (frozen system prompt + volatile part),
              models.ts (Haiku/Sonnet configs, prices), validate.ts (code-side checks), index.ts
src/time.ts   The Argentine calendar day and the date range of a query period
src/server.ts Entry point: config, migrate, startup sweep, 30 s sweep, HTTP server (`pnpm start`)
src/app.ts    node:http routes: GET /health, GET+POST /webhook (signature, dedupe, persist, 200)
src/store.ts  The rules of the tables (inbound_message, reply, account): due predicate, claim,
              the commit transaction (guard, then the command's effects, then the stored reply), ownership-guarded writes
src/ledger.ts All SQL on `movement`: live movements (not superseded, not deleted), insert, lock, supersede,
              soft delete, query totals
src/movement.ts Pure: text normalizing, applying a correction's changes, which fields changed
src/resolve.ts  Pure: turns a correct/delete target (list number, words, and the person's own message) into one movement or a question
src/execute.ts  Runs a command inside the commit transaction and returns the reply to store
src/process.ts  Per message: ignored vs reply; for text, typing + parse together, the 10 s interim note, the 30 s
              deadline, the commit point, the at-most-once send; drain on shutdown; the sweep
src/render.ts The reply templates (Argentine money format) and every canned text; pure
src/test-harness.ts  Shared integration-test setup: PGlite (or a real Postgres), fake Graph, fake Anthropic client, `setup()`
src/command-fixtures.ts  Scripted models, seeded movements and `say()` for the command tests
src/http.ts   keepAliveFetch: a fetch with its own 60 s keep-alive pool (Graph and Anthropic)
src/whatsapp/ signature.ts (HMAC), payload.ts (Zod parse of webhooks), graph.ts (Graph API client)
src/config.ts Zod-validated env; src/db.ts postgres.js + migrations; src/log.ts JSON logs
src/migrations/  Plain SQL, `NNN_name.sql`, applied once at startup under an advisory lock
src/latency.ts  `pnpm latency` report
evals/        cases.jsonl (dev/test split), grade.ts, run.ts, results/ (gitignored but summary.md)
docs/spec.md  Source of truth for what is built and in which order
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
pnpm eval [--model haiku|sonnet] [--split dev|test|all] [--concurrency N]   # calls the API, needs .env
```

`pnpm eval` spends money: tune the prompt on `--split dev` only and run `--split test` once per
model at the end. CI never calls the Anthropic API.

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
- **Logging flow (slice 3).** A text message from an allowed sender runs the read receipt plus typing and
  the parse together. Deadlines count from `received_at` and are processor options (`interimMs` 10 s,
  `deadlineMs` 30 s). The commit point is one transaction (`store.commit`): the parsed command, the
  movements (unique on `(inbound_message_id, position)`) and the stored `reply_text`. Before it, a failed
  parse or the deadline ends the message `failed` with one failure notice (`failure_sent_at`, committed
  before the send) and a late model result writes nothing. After it, the stored reply is sent even if late,
  and the sweep sends it without calling the model. The interim note (`interim_sent_at`) and the failure notice are committed before they are sent and never repeated. There is no done mark (a ✅ reaction was removed 2026-11-21). A model output with an
  unstorable value (bad amount, date or description) is treated as a failed parse, never repaired.
- Optional `HELP_CONTACT` adds a human contact line to the help reply; unset adds nothing.
- **Shutdown.** On SIGTERM `processor.stop()` aborts parses that have not reached the commit point and settles
  those rows to `pending`, so the next process's startup sweep answers them inside their deadline. The deadline
  is one `AbortSignal` checked right before the commit; a deadline that fires mid-commit loses (committed
  means the reply goes out). `today` comes from the message's own time (`meta_ts`), not the clock.
- **Corrections, deletes and queries (slice 4).** They run inside `store.commit`, in the same transaction as
  the guard and the stored reply, so a replay or a sweep re-claim never applies them twice (the stored reply
  is sent instead). **One sender's messages run strictly one after the other** (`run` chains them per
  `wa_id`, kick and sweep alike; different senders stay parallel), because a message reads its context before
  the parse and must see what the one before it stored. The turn passes at the commit, not at the send, so
  a burst does not also wait on each reply's send (replies can then arrive out of order when one send is
  slow; each names its own movements). A shutdown hands queued messages back as `pending`
  like the one in flight. The parser sees the account's last 10 live movements (`RECENT_LIMIT`, the most one
  message can log) as a numbered list and returns `target_index` plus `target`. Code (`resolveTarget`) reads
  the person's own message too, since `target` only echoes the row the model chose. A position the person
  wrote ("el 2", a bare "2", "el último") wins over the model's words and number; two positions in one
  message are two actions and get "una cosa por mensaje". Otherwise the rows whose description the words name
  (4-letter stems, or a whole category name, never a stem of a category or payment) are the candidates, the
  message's details (payment, old amount, hoy/ayer, dd/mm) narrow them, and the newest left wins; the reply
  shows the old values and, if not from today, the date. Nothing named asks `¿Cuál? 1. … · 2. …` plus how to
  answer and changes nothing. The parser also gets the sender's previous exchange (last message and its
  committed reply, at most 10 minutes old) so a bare "2" after a question works. Inside the transaction the live
  list is read again: if it differs from the one the model saw, the same question is asked. The target row is
  locked (`FOR UPDATE`) and must still be live, else the reply says it was already corrected or deleted. A
  corrected movement is a new row, so it counts as the newest. A `correct` whose new value cannot be stored
  gets a specific reply, not the failure notice. Query totals are `sum()` in SQL, grouped by direction and
  currency, never converted; the payment filter is accent- and case-insensitive contains. Changing
  `schema.ts` or `prompt.ts` means rerunning `pnpm eval` (see Slice 4 notes).
