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
3. **Corrections never overwrite a movement.** A correction is a new row that supersedes the old
   one, so history is kept.
4. **Secrets live only in the gitignored `.env`.** Never in code, logs, eval output or commits.

## Layout

```
src/parse/    parseMessage: schema.ts (command), prompt.ts (frozen system prompt + volatile part),
              models.ts (Haiku/Sonnet configs, prices), validate.ts (code-side checks), index.ts
src/time.ts   The Argentine calendar day
src/server.ts Entry point: config, migrate, startup sweep, 30 s sweep, HTTP server (`pnpm start`)
src/app.ts    node:http routes: GET /health, GET+POST /webhook (signature, dedupe, persist, 200)
src/store.ts  The rules of the tables (inbound_message, reply, account, movement): due predicate, claim,
              the commit transaction, ownership-guarded writes
src/process.ts  Per message: ignored vs reply; for text, typing + parse together, the 10 s interim note, the 30 s
              deadline, the commit point, the at-most-once send, the done mark; drain on shutdown; the sweep
src/render.ts The reply templates (Argentine money format) and every canned text; pure
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
  and the sweep sends it without calling the model. The interim note (`interim_sent_at`) and the ✅ mark (only on
  messages that stored movements, `reaction_sent_at`) are committed before they are sent and never repeated. A model output with an
  unstorable value (bad amount, date or description) is treated as a failed parse, never repaired.
- Optional `HELP_CONTACT` adds a human contact line to the help reply; unset adds nothing.
