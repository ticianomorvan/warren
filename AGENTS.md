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
src/store.ts  The rules of inbound_message and reply: due predicate, claim, ownership-guarded writes
src/process.ts  Decide ignored vs reply, read+typing, send at most once, drain on shutdown; the sweep
src/whatsapp/ signature.ts (HMAC), payload.ts (Zod parse of webhooks), graph.ts (Graph API client)
src/config.ts Zod-validated env; src/db.ts postgres.js + migrations; src/log.ts JSON logs
src/migrations/  Plain SQL, `NNN_name.sql`, applied once at startup under an advisory lock
src/latency.ts  `pnpm latency` report
railway.json  Railway config (build, start, healthcheck, region)
evals/        cases.jsonl (dev/test split), grade.ts, run.ts, results/ (gitignored but summary.md)
docs/spec.md  Source of truth for what is built and in which order
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome
pnpm typecheck
pnpm test          # Vitest, no network; real SQL on in-process PGlite, Graph API injected
pnpm start         # the server; needs DATABASE_URL and the WhatsApp variables (see src/config.ts)
pnpm latency [--last N]   # p50/p95 per stage from DATABASE_URL (Railway: the Postgres public URL)
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

- Railway project `warren` (US East, Virginia: `us-east4-eqdc4a`, pinned in `railway.json`), services
  `warren` (the app) and `Postgres`. Deploy by hand with `railway up -s warren` from the repo; there is no
  GitHub integration yet. `railway.json` is the legacy config format, supported until 2026-12-01. Moving to
  `.railway/railway.ts` (`railway config migrate --apply --variables unmanaged`, then `cutover`, `plan`,
  `apply`) needs the npm package `railway` as a devDependency; that is not done yet.
- **Single replica, single process.** The recovery sweep and the in-process worker assume it. The atomic
  claim stops a double send, but do not scale out without revisiting the sweep.
- The app reaches Postgres on the private network (`DATABASE_URL=${{Postgres.DATABASE_URL}}`). For
  `pnpm latency` from a laptop, build the URL from the Postgres service's `RAILWAY_TCP_PROXY_*` and `PG*`
  variables (a TCP proxy is enabled on that service). Never print it.
- Webhook host `wa.heywarren.app` (CNAME and TXT in Vercel DNS). The Meta subscription is set by API
  (`/{app-id}/subscriptions`, `/{waba-id}/subscribed_apps`), not in the dashboard.
- `ALLOWED_WA_IDS` (comma-separated, `+` and spaces ignored) is who gets a reply. `*` answers everyone (dev
  mode); empty or unset answers nobody. Every message is stored; the others end as `ignored`.
- Sends are at most once. `send_started_at` is committed before the Graph call; a row that dies after that
  (timeout, 5xx, killed worker) ends as `unknown` and is never sent again. Only an HTTP 4xx answer, which
  proves nothing was sent, goes back to `pending` (retryable codes) or `failed` (permanent codes).
