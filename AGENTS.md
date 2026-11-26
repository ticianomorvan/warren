# Warren

Warren is a personal-finance ledger for people in Argentina whose product is its MCP endpoint. The person brings their own agent (Claude,
ChatGPT, Cursor, a scheduled `claude -p`); the agent turns a sentence, a statement or a spreadsheet into movements and Warren stores them,
keeps every version and computes every total. Warren runs no model. How it works and why is in `docs/design.md`; this file holds the
rules and the layout. The earlier products are tags: `v0-mail-ledger` (a ledger from bank mail) and `v1-final` (the WhatsApp agent); the
WhatsApp agent of the rebuild, with its reminders, is in git history before the commit that cut Warren to MCP-only.

## Rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** An agent never adds, converts or rounds money. Amounts are decimal strings ("3500",
   "1500000.50"); code computes every total (SQL sums, `domain/summary.ts` in integer cents) and every tool result carries the figure as
   `amount` beside how Warren shows it (`display`). The server instructions and the tool descriptions say so to any agent.
2. **Every write goes through the guarded tools.** The tools are one registry (`src/core/commands.ts`, data only). Code checks every
   call (`core/guards.ts`: `checkValues`: the tool's shape, decimal amounts, real days not in the future, no long number in a
   description, a fact that is no secret), runs the writes at the commit point and renders every record, total and list from templates.
   An agent never picks a target in code's place: an id it sends must be the person's own and live at the commit point (a movement
   changed meanwhile answers "gone"). Every MCP call is entity-only against the live state. Nothing that deletes an account is a tool.
3. **Nothing is overwritten, deleted or un-deleted.** `movement` and `fact` are versioned: a change inserts a new version of the same
   `entity_id` and ends the old one (`ended_in`, `ended_at`); a delete only ends. An undo is made of the same moves, in its own turn.
   The `append_only()` trigger enforces it in the database: only the ended pair (once) changes in place. The one exception is deleting
   an account: every row of it goes in one transaction through the database function `erase_account`, which the trigger lets through
   and nothing else calls (`auth/account.ts`, behind a fresh sign-in, never over MCP).
4. **A turn is one unit of work, and its row is the commit point.** `core/turn.commit` is the only write path: in one transaction it
   takes the account lock, runs the guard hook, applies the writes (`core/apply.ts`) and inserts the `turn` row last, naming the
   `client` (the OAuth client id from the token, or `cli`). Undo is a strict stack in commit order across clients (`core/history.ts`):
   the newest turn that is neither an undo nor undone, all or nothing, within 24 h.
5. **Secrets are never kept.** The gitignored `.env` holds the keys, never code, logs or commits; Warren stores none of Google's tokens,
   only who signed in. What a client sends that looks like a secret (a card, a CBU, a password, a DNI) is stored nowhere: the turn keeps
   no input for that call, and a fact that holds one is refused.
6. **What Warren remembers about a person is theirs alone.** A fact is in the person's words (key and numbers), refused if it is a
   secret or contact data, read and changed only through its own account, and everything of a person goes with "delete account" on
   the account page.

## Layout

```
src/core/      Pure rules and the one write path. commands.ts (the tool registry), guards.ts (checkValues), apply.ts (applyCall: the six
               writes as an Outcome), turn.ts (commit: lock, guard, writes, turn row, after), history.ts (versions and the undo engine),
               describe.ts (the Spanish record line of an outcome), es.ts (names, money, dates), numbers.ts, secrets.ts, values.ts,
               db.ts (postgres.js, migrations, bigint ids as numbers), schema/001_init.sql and 002_auth.sql
src/domain/    movements.ts (and the 100,000 live-movement cap), facts.ts, totals.ts, run-summary.ts, range.ts, summary.ts,
               render-summary.ts, import.ts (a backlog as one cli turn)
src/mcp/       endpoint.ts (instructions, origin check, door, stateless server per request), door.ts (token checks, calls per minute),
               tools.ts (one tool per registry entry), clients.ts (the allowed OAuth client hosts)
src/auth/      config.ts (better-auth: Google, jwt, mcp, cimd), routes.ts (sign-in, consent, account), pages.ts (the HTML), account.ts
               (disconnect, export, erase)
src/web/       content.ts (landing, setup, privacy, terms and llms.txt in Markdown), markdown.ts, site.ts (pages and their Markdown twins),
               send.ts (page headers and CSP)
src/app.ts     node:http: /health, /mcp, the OAuth routes and the web, the last three only on PUBLIC_URL's host
src/warren.ts  createWarren(deps): the one wiring, used by server.ts and the tests
src/import.ts  the import command; test/ the kit (db.ts: useDatabase, until.ts, core.ts); src/auth-test-kit.ts and src/test-harness.ts
               start the whole app with a fake claude.ai and a fake Google
docs/          design.md (how Warren works and why)
```

How a call goes: the client sends a JSON-RPC request to `/mcp` with a bearer token; the origin check, then the door (signature, issuer,
audience, expiry, `at+jwt`, a user that stands for an account that has not disconnected its agents, calls per minute) names the
account and client; a read runs its query; a write goes through `checkValues`, then `commit` (the account lock, the live-movement cap,
the request-id replay, the writes, the turn row) and answers with structured output.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint            # Biome
pnpm typecheck
pnpm test            # Vitest, no network; real SQL on in-process PGlite, Google and claude.ai faked
pnpm check           # lint + typecheck + test: what CI's `check` job runs
# The whole suite on a real Postgres (each file in its own schema, dropped after; the race tests run only here): what CI's `postgres` job runs.
docker run --rm -d --name warren-pg -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17
PG_TEST_URL=postgres://postgres:postgres@localhost:55432/postgres pnpm test      # RACE_RUNS=5 repeats each race; stop the container after
pnpm start           # the server: DATABASE_URL, PORT, and with PUBLIC_URL also BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (src/config.ts)
pnpm import:movements <file.jsonl> (--account <id> | --email <google email>) [--check]   # a backlog (one log_movements movement per line)
                     # as one turn on DATABASE_URL; --check runs the guards and writes nothing; one `warren_undo_last` takes the
                     # whole import back within 24 h. From a statement or a spreadsheet: the `import-statement` skill (.claude/skills/)
```

## Conventions

- Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional Commit (`feat:`, `fix:`, `docs:` ...).
  Every commit is signed off: `git commit -s`. See `CONTRIBUTING.md`.
- Pin GitHub Actions by full commit SHA with a version comment; workflows default to `permissions: contents: read`. Never use
  `pull_request_target` with a checkout of the pull request.
- pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside `allowBuilds` (`pnpm-workspace.yaml`). Do not widen
  either without a reason in the commit.
- Node 24 (`.nvmrc`), TypeScript strict, Biome formatting, Zod 4. No new dependency without a reason.
- The schema is `src/core/schema/001_init.sql` and `002_auth.sql`, applied once each under an advisory lock at start. They were
  rewritten once, when the database was dropped and recreated for the MCP-only cut; from then on production runs them, so a change is a
  new numbered file, never an edit. `002_auth.sql` is better-auth's schema as plain SQL: `test/migrations.test.ts` fails when a plugin
  or an upgrade wants a table or column that is not there (`pnpm tsx src/auth/print-schema.ts`).
- Prefer what the platform already ships (Postgres constraints, zod, the SDKs) over machinery of our own.
- Every test file that touches the database uses `useDatabase()`; waits use `until()`, never a fixed sleep.

## Deploy

- Railway project `warren` (US East), one environment `production`, services `warren` (the app) and `Postgres`. Deploy by hand with
  `railway up -s warren`.
- Railway settings live in `.railway/railway.ts` (Infrastructure as Code): build, start `pnpm start`, healthcheck `/health`, restart on
  failure, one replica, the domain and the Postgres proxy (a 15 s drain and an overlap for a deploy). Variables are unmanaged: the file
  never holds secrets; set them with `railway variables`. Run `railway config plan` before `apply`: a plan that is not "already up to
  date" means someone changed the service by hand.
- **One replica.** The rate limits (the door's calls per minute, better-auth's on the auth routes) are in memory; do not scale out
  without moving them to the database.
- The app reaches Postgres on the private network (`DATABASE_URL=${{Postgres.DATABASE_URL}}`). Never print a connection URL or a token.
- The host is `heywarren.app` (`PUBLIC_URL`). The sign-in, the OAuth server, the web and `/mcp` exist only when `PUBLIC_URL` is set; they
  then need `BETTER_AUTH_SECRET` (32+ characters), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Google Cloud OAuth client whose
  redirect URI is `https://heywarren.app/api/auth/callback/google`, with the privacy and terms pages set as `https://heywarren.app/privacy`
  and `/terms`). The routes answer only on `PUBLIC_URL`'s host; `/health` answers on any.
