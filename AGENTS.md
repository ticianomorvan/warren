# Warren

Warren is a WhatsApp expense agent for people in Argentina, also reachable over MCP (Claude and other agents). A person writes
"café 3500 y súper 12.000 con la visa, ayer 20 lucas de nafta" and gets one compact reply listing what was understood. They fix it in
plain words ("no, el café fue 3800", "borrá el último"), ask simple questions ("¿cuánto gasté este mes en super?"), set reminders and
tell Warren things to remember. How it works and why is in `docs/design.md`; this file holds the rules and the layout. The previous mail-ledger product is the
tag `v0-mail-ledger`; v1 of this product is the tag `v1-final`.

## Rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** A model never adds, converts or rounds money. Amounts are decimal strings ("3500",
   "1500000.50"); code computes every total (SQL sums, `domain/summary.ts` in integer cents).
2. **The model acts only through guarded tools.** The tools are one registry (`src/core/commands.ts`, data only). A short loop
   (`agent/loop.ts`, at most 3 model turns) calls them; code checks every call twice (`core/guards.ts`: `checkValues`, which MCP shares,
   then `checkTurn`, the conversation's rules), runs the writes at the commit point and renders every record, total, list, question and
   refusal from templates. Free text exists only in `reply`, which goes alone and passes `core/reply-check.ts` (no number code did not give,
   no claim of a change that was not made). The model never picks a target in code's place: an id it sends must be one it was shown, the
   person's own, live, and, over WhatsApp, still **the version it was shown**: code (never the model) attaches the shown version to the
   call, and a movement changed meanwhile answers "gone" instead of being changed in its new form. An MCP client always sees the live
   state, so its calls are entity-only.
3. **Nothing is overwritten, deleted or un-deleted.** `movement`, `fact` and `reminder` are versioned: a change inserts a new version of the
   same `entity_id` and ends the old one (`ended_in`, `ended_at`); a delete only ends. An undo is made of the same moves, in its own turn.
   The `append_only()` trigger enforces it in the database: only the ended pair (once) and, for a reminder that is still live, `next_due_at`
   change in place.
4. **A turn is one unit of work on any channel, and its row is the commit point.** `core/turn.commit` is the only write path: in one
   transaction it takes the account lock, applies the writes (`core/apply.ts`), composes the reply and inserts the `turn` row last. Undo is
   a strict stack in commit order across channels (`core/history.ts`): the newest turn that is neither an undo nor undone, all or nothing;
   a reminder that can never come back blocks it and the reply says why.
5. **Secrets are never kept.** The gitignored `.env` holds the keys, never code, logs, eval output or commits. What a person writes that
   looks like a secret (a card, a CBU, a password, a DNI) is stored nowhere: the message's text becomes `[dato sensible, no guardado]` and
   the audit and the turn's inputs lose theirs.
6. **What Warren remembers about a person is only what they said, and is theirs alone.** A fact is in their words (key and numbers), refused
   if it is a secret or contact data, shown only to its own person in the per-message context (never in the cached prefix), and
   forgetting everything runs only on the person's own "sí" to code's "¿Seguro?".

## Layout

```
src/core/      Pure rules and the one write path. commands.ts (the tool registry), guards.ts (checkValues, checkTurn, Shown), reply-check.ts,
               apply.ts (applyCall: the nine writes as an Outcome), turn.ts (commit: claim, lock, guard, writes, compose, turn row, after),
               history.ts (versions and the undo engine), describe.ts (the Spanish line of an outcome), es.ts (names, money, dates), numbers.ts,
               secrets.ts, values.ts, fit.ts, db.ts (postgres.js, migrations, bigint ids as numbers), schema/001_init.sql and 002_auth.sql
src/domain/    movements.ts, facts.ts, totals.ts, run-summary.ts, range.ts, summary.ts, render-summary.ts, reminders/ (schedule, describe, guard,
               db, send: the sender)
src/agent/     understand.ts (a message to the calls for commit), context.ts (state read and the context the model is shown), prompt.ts,
               examples.ts, tools.ts (the registry shaped for the Anthropic API), loop.ts, reply.ts (what code renders beside the writes), models.ts
src/whatsapp/  payload.ts, ingest.ts, queue.ts (wa_message as a queue), worker.ts (lanes per sender), send.ts (stamp, then send), media.ts,
               graph.ts, resolve.ts (code's answers: option numbers, "sí", "deshacer", sign-in), replies.ts
src/mcp/       endpoint.ts, door.ts (token checks), tools.ts (one tool per registry entry with an `mcp` block), clients.ts
src/auth/      better-auth config, the WhatsApp sign-in (link.ts, answer.ts), routes, pages, disconnect.ts
src/app.ts     node:http: /health, /webhook (signature, store, 200, first signal), /mcp, the OAuth routes
src/warren.ts  createWarren(deps): the one wiring, used by server.ts, the tests and the eval
test/          the kit: db.ts (useDatabase: a schema per file on PG_TEST_URL, PGlite otherwise), fakes.ts, until.ts, core.ts, golden/
evals/scenarios/  the scenario eval (scenarios.jsonl, long-ledger.jsonl, drive.ts, grade.ts, report.ts, results/)
scripts/       probe.ts (staging and production probe), graph-sink/ (staging only)
docs/          design.md (how Warren works and why)
```

How a message goes: the webhook stores it (`wa_message`, `pending`), answers 200 and sends the first signal (read receipt and typing) for
each new message of an allowed sender; a lane per sender claims its oldest due row (`whatsapp/queue.ts` is the one owner of what holds a
sender back: an older open row with no turn, of a kind that goes through the agent); `worker.ts` reads the state, asks `resolve.ts` whether
code can answer alone, else runs `understand` (the model), then `commit`, then sends the stored reply at most once (`send_started_at` is
committed before the Graph call; only a 4xx proves nothing was sent). Reads in a turn are rendered inside the commit transaction after the
writes, so "café 2800, ¿cuánto llevo hoy?" sees the café.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint            # Biome
pnpm typecheck
pnpm test            # Vitest, no network; real SQL on in-process PGlite, Graph and Anthropic injected
pnpm check           # lint + typecheck + test: what CI's `check` job runs
# The whole suite on a real Postgres (each file in its own schema, dropped after; the race tests run only here): what CI's `postgres` job runs.
docker run --rm -d --name warren-pg -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17
PG_TEST_URL=postgres://postgres:postgres@localhost:55432/postgres pnpm test      # RACE_RUNS=5 repeats each race; stop the container after
pnpm start           # the server: DATABASE_URL, ANTHROPIC_API_KEY, the WhatsApp variables (src/config.ts); OPENROUTER_API_KEY turns voice notes on
pnpm latency [--last N]   # p50/p95 by turn label and by stage, from DATABASE_URL
pnpm eval:scenarios [--split dev|test|all] [--only s001,s002] [--file evals/scenarios/long-ledger.jsonl] [--budget 0.30] [--concurrency 4]
                     # multi-turn scenarios through the real pipeline and model; needs .env and spends money (a whole run is about US$0.17)
pnpm eval:report     # writes evals/scenarios/results/latest.md from the newest three *-all.json runs
pnpm probe staging|production   # signed webhooks, MCP and a reminder against the environment (staging) or a read-only check (production)
pnpm template:status | pnpm reminder:try-template <wa_id>   # the reminder template at Meta; the second sends a REAL message
```

The eval's `test` split is held out: never print or tune on it. `pnpm eval:report` is the only writer of `latest.md`; never edit it by
hand. The bar a change to the agent must meet is in `docs/design.md` ("Tests and evals").

## Conventions

- Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional Commit (`feat:`, `fix:`, `docs:` ...).
  Every commit is signed off: `git commit -s`. See `CONTRIBUTING.md`.
- Pin GitHub Actions by full commit SHA with a version comment; workflows default to `permissions: contents: read`. Never use
  `pull_request_target` with a checkout of the pull request.
- pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside `allowBuilds` (`pnpm-workspace.yaml`). Do not widen
  either without a reason in the commit.
- Node 24 (`.nvmrc`), TypeScript strict, Biome formatting, Zod 4. No new dependency without a reason.
- The schema is `src/core/schema/001_init.sql` and `002_auth.sql`, applied once each under an advisory lock at start. Production runs
  them, so a change is a new numbered file, never an edit. `002_auth.sql` is better-auth's schema as plain SQL:
  `test/migrations.test.ts` fails when a plugin or an upgrade wants a table or column that is not there (`pnpm tsx src/auth/print-schema.ts`).
- Prefer what the platform already ships (Postgres constraints, zod, the SDKs) over machinery of our own.
- Every test file that touches the database uses `useDatabase()`; waits use `until()`, never a fixed sleep.

## Deploy

- Railway project `warren` (US East), services `warren` (the app) and `Postgres`, plus a `staging` environment with its own service,
  Postgres and `graph-sink` (it records sends so staging never messages a real phone). Deploy by hand with `railway up -s warren`.
- Railway settings live in `.railway/railway.ts` (Infrastructure as Code): build, start `pnpm start`, healthcheck `/health`, restart on
  failure, one replica, the domain and the Postgres proxy (a 15 s drain and an overlap for a deploy, in both environments). Variables are unmanaged: the file
  never holds secrets; set them with `railway variables`. Run `railway config plan` before `apply`: a plan that is not "already up to date"
  means someone changed the service by hand.
- **One replica.** The claim stops a double send, and the old instance of a deploy never has its row overtaken by the new one's, but do not
  scale out without revisiting the sweep.
- The app reaches Postgres on the private network (`DATABASE_URL=${{Postgres.DATABASE_URL}}`). Never print a connection URL or a token.
- Webhook host `wa.heywarren.app`; the Meta subscription is set by API, not in the dashboard. `ALLOWED_WA_IDS` (comma-separated, `+` and
  spaces ignored) is who gets a reply: `*` answers everyone (dev), empty answers nobody (messages are stored, `ignored`).
- `GRAPH_BASE_URL` (an origin, no path) points Graph calls somewhere else; staging points it at the graph-sink. Unset is Meta's.
- **Meta test number:** it only delivers to its recipient list, matched exactly; Argentine mobiles are saved without the `9`, while webhooks
  give `549…`. `graph.sendText` retries once with the short form after a 131030 and remembers it. The symptom is `131030 Recipient phone
  number not in allowed list` on every send while read and typing still work.
- MCP and sign-in are off unless `PUBLIC_URL` (`https://heywarren.app`) is set; they then need `BETTER_AUTH_SECRET` (32+ characters) and
  `WHATSAPP_DISPLAY_NUMBER`. The routes answer only on `PUBLIC_URL`'s host. Reminders send text inside 23 h of the person's last message and
  the template `REMINDER_TEMPLATE` (`warren_reminder`, `es_AR`) outside it; unset, no template is ever sent.
