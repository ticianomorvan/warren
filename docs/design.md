# How Warren works, and why

Rules and layout are in [`AGENTS.md`](../AGENTS.md). This file says how the parts fit and why they are shaped so. History is in git.

## Shape

Warren is a ledger server whose product is its MCP endpoint. The person brings their own agent (Claude, ChatGPT, Cursor, a scheduled
`claude -p`); what happens between them is not ours. Ours are the tools, the rules the tools enforce and, in later slices, the skills and
instructions that teach any agent to turn a statement, a sentence or a spreadsheet into movements. Warren runs no model: no prompt, no
loop, no model keys.

```text
 person ── their agent ──MCP (OAuth, Google sign-in)──▶ /mcp ─ door ─ tools ─▶ checkValues ─▶ turn.commit ─▶ Postgres
```

Every unit of work is one `turn` and goes through one write path, one undo engine and one tool registry. One process, one replica.

Settled choices. Do not reopen without new evidence:

- No agent framework, no Drizzle, no queue library, no hosted auth. Postgres constraints, zod, the SDKs and better-auth do the work.
- Warren never reads the person's mail or files: their agent does. Warren never holds Gmail or Drive access: Google is only how a
  person proves who they are.
- An agent is not defended against: the guards stop bad values and arithmetic, not a wrong but valid row from the person's own agent.
- Resolving a write's target in code by matching text is rejected: one wrong hit is a silent wrong change. An agent names the id.
- Rejected: Warren running its own model behind MCP (it pays for a second agent the person already has), and keeping WhatsApp dormant
  behind a flag (nobody would maintain it). WhatsApp, voice notes and reminders were deleted, not kept.

## Data

- `account` is the person. `auth_user.warren_account_id` links the Google user to it, and the user's create hook makes both.
  `account.mcp_revoked_at` is "disconnect all agents": the door refuses every token issued at or before it.
- `turn` is the committed unit of work: `account_id`, `client` (the OAuth client id from the token, or `cli`), `calls`, `record`,
  `undoes`. It is inserted last, inside the commit transaction, so its existence is the commit point. Undo order is turn id order.
  `mcp_request(account_id, request_id)` makes a write idempotent.
- `movement` and `fact` are versioned the same way: `entity_id` (stable across versions), `made_in`, `ended_in`, `ended_at`, and one
  live version per entity (`UNIQUE (entity_id) WHERE ended_at IS NULL`). Live means `ended_at IS NULL`. Agents see `entity_id`.
- The `append_only()` trigger enforces it: no delete; only `ended_*` (once) change in place. It is an AFTER ROW trigger because a BEFORE
  trigger does not see the generated `movement.search` column. A DELETE is let through only while the transaction-local setting
  `warren.erasing` names the row's own account, which only `erase_account` (002_auth.sql) sets.
- `made_in` and `ended_in` are `DEFERRABLE INITIALLY DEFERRED`. `applyCall` needs the turn id before the turn row exists. `commit`
  reserves the id with `nextval` after the account lock, so one account's turn ids follow commit order. A transaction that never
  inserts its turn cannot commit a version.
- Every write transaction takes one lock first: `SELECT 1 FROM account WHERE id=$1 FOR NO KEY UPDATE`. The only advisory lock is the
  migration runner (7203001).
- `amount` has `CHECK (scale(amount) <= 2)`. `movement.search` is a generated, accent-folded column that searches use.
- When an `ORDER BY` follows `SELECT entity_id AS id, id AS version`, the output name wins. Order by the qualified column
  (`movement.id`).
- A turn's `created_at` and every new entity's `logged_at` are the call's own time, so the undo window is deterministic.
- The schema was rewritten once as the target for a fresh database (the old production database was dropped and recreated). From then on a
  change is a new numbered file.

## Core

- `commands.ts` is a registry of data only: input (zod), `read` or `write`, and the `mcp` block (title, description, scope, output
  schema, request-id and page fields). The MCP tools derive from it. Guards, apply and describe are exhaustive switches over it.
- `checkValues` holds the value rules (shape, decimal amounts, real days not in the future, no long number in a description or
  payment, a fact that fits and is no secret). Declines are typed (`secret`, `contact`), so a client reads a code, never prose.
- `applyCall(tx, ctx, call) -> Outcome` is the one write path for the six writes. An Outcome has a tool, one closed `status` and an
  `effect`. `describe` renders it to the Spanish `record` line.
- Undo derives effects from versions: per entity, what the turn ended and what it made. A turn's own intermediate versions are
  ignored. Versions made by an undone turn or by an undo do not count. Undo is a strict stack in commit order, across clients, all or
  nothing, within 24 hours; movements and facts are undone alike. "A turn made after the log goes first": an undo takes the newest
  turn that is neither an undo nor undone.
- Results keep their first shape for now: structured output with `amount` and `display`, plus the Spanish `record` and `summary` text.
  Pure structured data, source references and a bulk import tool are the next slices.

## Auth

- better-auth with its `jwt`, `mcp` and `cimd` plugins, over Kysely. The MCP SDK only checks tokens. Clients are CIMD only (dynamic
  registration is off), and client-id hosts are allowed only from `mcp/clients.ts` (today `claude.ai` and `claude.com`). Discovery
  advertises both CIMD support and `"none"` token auth, since Claude falls back to dynamic registration unless it sees both, and the
  SDK's legacy protocol negotiation stays on because hosted Claude speaks the 2025-11-25 auth. Tokens are 15 min JWTs with `aud` = the
  MCP URL; refresh tokens rotate. The tables are plain SQL in `002_auth.sql`; `test/migrations.test.ts` fails on drift.
- **Google is the only way in, and it is open to anyone.** `socialProviders.google` only; email sign-up and sign-in are off. The first
  Google callback of a person makes their `auth_user`; its `after` hook makes the `account` row and sets `warren_account_id`. The
  `before` hook refuses any user not made by Google's callback, so no other route a plugin may add can make one (a test holds that).
  Google's tokens are blanked before they are stored: Warren keeps only that this user signed in with this Google account.
- Open sign-up needs limits so one account cannot fill the database: better-auth's rate limit on the auth routes (in memory), a cap of
  100,000 live movements per account (the typed code `movement_limit`, counted under the account lock) and 120 calls a minute per
  account at the door (HTTP 429 with the code `rate_limited`, counted only for requests the door admitted).
- The door (`door.ts`) is authentication only: signature, issuer, audience, expiry, `typ: at+jwt`, `azp`, a user that stands for an
  account, and that account has not disconnected since the token was issued. Every refusal is one 401. A database that cannot answer
  is a 503. Scope is each tool's (`ledger:read`, `ledger:write`). The `azp` is the `client` of every turn.
- Origin is checked exactly (`new URL(origin).origin` against the allowed hosts), because the SDK helper compares hostnames only.
- Tools come from the registry, named `warren_<tool>`, plus `request_id`, `limit`, `cursor`. A call that changes nothing leaves no turn
  and no `mcp_request` row, so the id can be reused. The same `request_id` with the same input replays the first answer.
- Free text is bounded to 200 characters, and `find_movements` text to 10 words, in `mcp/tools.ts`.
- The server `instructions` carry the rules in their first 512 characters (never compute money, quote `display`, use the summary tool
  for totals, ask before a choice that changes totals) and name no chat app: any MCP client reads them.

## The web

The web is only the door, and an agent can read it. "Set up Warren" said to any agent is enough: it finds the server, connects it in
its own client and hands the person only what it cannot do (a sign-in click, adding a connector in claude.ai's settings).

- Every page has a Markdown twin: `/setup.md`, `/privacy.md`, `/terms.md`, and `Accept: text/markdown` on `/` (also `/index.md`);
  `/llms.txt` indexes them. `web/content.ts` holds each document once, as Markdown, and `web/markdown.ts` renders the small subset it
  uses to HTML, so a page and its twin cannot drift. The landing, privacy and terms are Spanish, for people; `/setup.md` is English,
  for agents, with the exact commands per client. The MCP endpoint answers an unauthenticated request with the standard `401` and
  `resource_metadata`, so a client discovers the auth on its own.
- Privacy and terms are honest and short, for a free personal project with no legal entity: no company is named, contact is the
  repository's issues, and the privacy page says what is stored, that Google tokens are not, and how to delete it. Google's consent
  screen asks for both on our domain.
- Pages are plain server-rendered HTML under a CSP nonce, with no outside assets and one small script where a button needs it
  (`auth/pages.ts`).
- The sign-in page is "Continuar con Google": a fetch to `/api/auth/sign-in/social` with the signed OAuth query of an agent's
  authorization, so better-auth resumes the authorization after Google; opened by hand it leads to `/account`.
- The account page (`/account`) does three things that must happen outside a chat. **Disconnect all agents** sets
  `account.mcp_revoked_at`. **Download all data** returns every version of every row as JSON, from one snapshot. **Delete the account**
  needs a session younger than five minutes (the page offers a fresh Google sign-in otherwise) and runs `erase_account`, the one
  database function the append-only trigger lets through. The writes are POSTs from our own origin, and each acts on the signed-in
  session's account, never on one the request names. Deleting is never an MCP tool an agent could call (a test reads the sources to
  hold that `erase_account` has one caller).

## Tests

- Layers: pure tables; contract tests on the database (`apply`, `history`, `turn`, the schema); the whole app over HTTP with real
  better-auth, a fake claude.ai (its metadata document, PKCE, a cookie jar) and a fake Google (the code is the email, and the token
  endpoint answers with an ID token for it); race tests. Tests use `useDatabase()` (a schema per file on `PG_TEST_URL`, PGlite
  otherwise). Waits use `until()`.
- CI has two jobs: `check` (PGlite) and `postgres` (the whole suite on `postgres:17`, where the race tests run). A race change needs
  both, many times (`RACE_RUNS`).

## Ops

- Railway settings are code (`.railway/railway.ts`). The app is one replica with a 15 s drain and overlap. See `AGENTS.md` for the rest.
- `pnpm import:movements` seeds a person's backlog (a spreadsheet, old statements) as one turn for the client `cli`: every 10 rows are
  one `log_movements` call, checked by `checkValues` before anything is written, then one `commit`. One refused row and nothing is
  written. Being one turn, the import is one step of the undo stack, and the newest one. An import is capped at 5,000 rows, to hold the
  lock for seconds, and by the account's 100,000-movement cap. The same rows imported again into the same account, while the first
  import is not undone, are refused under the lock (the stored calls' tool and input are compared). The person is found by
  `--account <id>` or the Google `--email` they signed in with. Rejected: seeding through `warren_log_movements`, which is 10
  movements a call and one undo step per call.
- There is no production probe or staging environment in this slice: `/health` answers `ok` with the build in `x-warren-build`, and an
  unauthenticated `POST /mcp` answers 401 with the discovery challenge.
