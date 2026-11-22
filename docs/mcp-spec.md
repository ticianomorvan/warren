# Slice 5: people as accounts, and Warren over MCP

Status: spec, waiting for Ticiano's read (2026-11-22). Builds on `docs/agent-spec.md` and `AGENTS.md`.

## Goal

A person adds Warren as a connector in claude.ai (or Claude Code), signs in by sending one WhatsApp
message to Warren, and from then on their agent can read and write the same ledger and memory that
WhatsApp uses, through the same code guards. WhatsApp becomes one channel of the core, MCP a second.

Done means:
- `https://wa.heywarren.app/mcp` answers 401 with RFC 9728 metadata; claude.ai and Claude Code finish
  OAuth against it (CIMD, PKCE S256, audience-bound token) with no client registration step.
- Sign-in: the page shows a code and a `wa.me` link; the person sends it, Warren asks "¿Conectar
  Claude…? sí/no", "sí" completes the browser flow. No email, no password, no outbound template.
- Live: in claude.ai, "¿cuánto gasté este mes en súper?" returns code-computed totals; "anotá un café
  de 2500" logs a movement; "deshacer" on WhatsApp then undoes that MCP write.
- `pnpm test` (incl. an OAuth + MCP end-to-end test) and `pnpm eval:scenarios` hold their bars
  (≥95%, 0 silent wrong changes, 0 invented numbers) — the WhatsApp path does not regress.

## Not doing

- Other channels (Telegram, web app), other sign-in methods, email.
- Exposing Warren's own agent as a tool (`ask_warren(text)`): two models in series, slower, and the
  client agent loses the structure. The client agent is the agent; Warren gives it guarded tools.
- `forget_all_facts`, `ask_user`, `reply`, `help` over MCP. Forget-all needs the person's own "sí" on
  WhatsApp (AGENTS.md rule 5); the other three are WhatsApp conversation.
- Dynamic Client Registration. The spec marks it deprecated; Claude uses CIMD when the AS advertises it.
- A batch table and renaming `inbound_message`: that is the post-slice-6 overhaul. This slice adds a
  `channel` column instead (see Design 4).
- Rate limiting beyond the sign-in code endpoints; MCP resources and prompts.

## What exists

- `account(id bigserial, wa_id unique)` is the person (003). Created lazily by `store.upsertAccount`
  (`src/store.ts:180`). Every ledger and fact query takes `accountId`.
- Allow-list `ALLOWED_WA_IDS` (`src/config.ts`), enforced in `work()` (`src/process.ts:461`).
- Tool inputs `TOOL_INPUTS` (`src/agent/schema.ts:153`); DB-free guards `checkCall`/`checkSummary`
  (`src/agent/calls.ts`); value rules `checkLog`/`checkChanges` (`src/agent/validate.ts`).
- Writes run in `execute()` (`src/execute.ts:150-344`) inside `store.commit` (`src/store.ts:261`),
  which is welded to the claimed inbound row and composes the Spanish reply.
- Ledger SQL composes in any `sql.begin`: `insertMovements`, `supersede`, `softDelete`,
  `findMovements`, `summaryRows` (`src/ledger.ts`); facts (`src/facts.ts`); undo (`src/undo.ts`).
- Undo batch = an `inbound_message` row with `action` and `reply_text` set; movement and fact rows
  point at it (`inbound_message_id NOT NULL`). `lastBatch` (`src/ledger.ts:148`) and the conversation
  window (`src/store.ts:221,233`) join on `wa_id`.
- Routes: `src/app.ts` `handle()` — `/health`, `/webhook`. No router, no JSON or HTML helpers.
- v0 (tag `v0-mail-ledger`, commits 3191156, 1e09415, 445aa73): better-auth `jwt` + `mcp` + `cimd`,
  CIMD-only with client-id hosts allow-listed to `claude.ai`/`claude.com`, hardened metadata fetch,
  15-min JWT with `aud` = MCP URL, refresh rotation, user-exists check at the door, user id only from
  verified auth, tool output conventions (decimal strings + `display`, `structuredContent`).
  Read `git show 1e09415:docs/architecture.md` before building.

## Design

1. **Identity.** `account` stays the person; no second user concept in Warren's code. better-auth
   keeps its own tables, all renamed with an `auth_` prefix (its `account` model collides with ours),
   and `auth_user` gets one extra field `warren_account_id bigint unique references account(id)`.
   `auth_user.email` is a placeholder `a<id>@users.invalid` (better-auth requires one; no personal data).
   Rejected: making `account` the better-auth user model — id type and required fields fight it.

2. **Auth server.** better-auth (newest version past pnpm's 3-day age, ≥1.7.26) with `jwt`
   (`disableSettingJwtHeader`), `@better-auth/mcp`, `@better-auth/cimd` (`metadataProfile:
   "mcp-2026-07-28"`, Node hardened fetcher, client-id hosts `claude.ai`, `claude.com`), DCR and
   `/token` disabled, grants `authorization_code` + `refresh_token`, rotation with no reuse window.
   Scopes `ledger:read`, `ledger:write`, `offline_access`. Access JWT 15 min, `aud` = MCP URL.
   Database: Kysely `PostgresJSDialect` over our existing `postgres` instance. Its schema is generated
   once with the better-auth CLI and committed as plain SQL `012_auth.sql`, applied by our `migrate`
   — one migration system. Session lifetime 1 h: it only exists to finish consent.
   Rejected: a hand-written AS (~700 lines). Smaller dependency tree, but CIMD fetching (SSRF, DNS
   rebinding) and refresh rotation are where bespoke OAuth goes wrong, and v0 already proved this config.

3. **Sign-in by WhatsApp** (no sign-in plugin; a tiny better-auth plugin endpoint mints the session).
   - `GET /sign-in` (better-auth `loginPage`): creates `link_request(id, code, browser_secret_hash,
     client_name, expires_at = now()+10 min, account_id null, confirmed_at null)`, sets an httpOnly
     cookie holding the browser secret, renders the code (6 chars, unambiguous alphabet), a
     `https://wa.me/<number>?text=vincular%20<code>` button and a QR of it for desktop. Spanish.
   - Inbound WhatsApp, code-first before the agent (like `undoRequest`): `vincular <code>` matching an
     open request from an allowed sender stores `account_id` and Warren asks
     "¿Conectar Claude (claude.ai) a tu cuenta de Warren? Va a poder ver y anotar tus movimientos.
     Respondé sí o no." The next "sí" from that sender within the expiry sets `confirmed_at`. Unknown,
     expired or used codes get one neutral refusal (no oracle). This is the anti-phishing step: a code
     someone else asked you to send still needs your explicit "sí" naming the client.
   - The page polls `GET /sign-in/status`; when confirmed and the cookie's secret matches, the endpoint
     finds or creates the `auth_user` for that account, sets the better-auth session and redirects
     back into the OAuth flow. The request is single-use.
   - Rejected: Warren sends an OTP. Outside the 24 h window that needs a paid, Meta-approved
     authentication template; the inbound code is free and needs no phone number typed.

4. **One write path for both channels.** Extract from `execute()` a channel-neutral
   `applyCall(tx, {accountId, requestId, today}, call) → Outcome` per write tool (validation via
   `checkCall` + `validate.ts`, ownership and liveness checks, the ledger/facts SQL). WhatsApp's
   `execute()` keeps composing the reply from outcomes; MCP returns them as structured content.
   An MCP write opens `sql.begin`, inserts an `inbound_message` row with `channel = 'mcp'`,
   `wamid = 'mcp:<uuid>'`, the account's `wa_id`, status settled, `action` and a `reply_text` summary,
   then calls `applyCall`. So undo (either channel) sees MCP batches unchanged. Migration `013_channel`
   adds `inbound_message.channel text not null default 'whatsapp'`; the conversation window, sweep and
   claim read only `channel = 'whatsapp'`. Id guard over MCP: the id is the account's and live (the
   "shown to the model" rule cannot apply to a client agent; stale-state guards still do).

5. **MCP endpoint.** `POST /mcp` via `@modelcontextprotocol/server` 2.4 `createMcpHandler` (stateless,
   new `McpServer` per request) + `@modelcontextprotocol/node` `toNodeHandler`, wrapped in try/catch.
   The door: verify the JWT in-process (`aud`, `typ: at+jwt`, `azp` required), `sub` → `auth_user` →
   account, account's `wa_id` still allowed; else 401 with `WWW-Authenticate` + `resource_metadata` and
   `scope`. DB down → 503. Account id reaches tools only from the door. Tokens are never logged.
   Tools (`readOnlyHint`/`destructiveHint` set, `openWorldHint: false`, `outputSchema`, inputs from
   `TOOL_INPUTS`):
   read (`ledger:read`) `warren_find_movements`, `warren_summarize`, `warren_list_facts`;
   write (`ledger:write`) `warren_log_movements`, `warren_correct_movement`, `warren_delete_movement`,
   `warren_undo_last`, `warren_remember_fact`, `warren_forget_fact`.
   Amounts as decimal strings plus a code-rendered `display`; `summarize` also returns the
   `renderSummary` text. Refusals are `isError` results with the compact reason `checkCall` gives.
   Routes added to `handle()`: `/mcp`, `/api/auth/*`, `/.well-known/oauth-authorization-server`,
   `/.well-known/oauth-protected-resource` (+ `/mcp`), `/sign-in`, `/sign-in/status`, `/oauth/consent`.
   Config: `PUBLIC_URL`, `BETTER_AUTH_SECRET`, `WHATSAPP_DISPLAY_NUMBER`.

From scratch we would put a channel-neutral batch table under both channels; the `channel` column is
the smallest step that keeps undo shared, and the overhaul can replace it with that table.

## Slices

1. **Auth server and WhatsApp sign-in.** Deps, `012_auth.sql`, `link_request`, the routes above except
   `/mcp` tools (the endpoint answers 401 with metadata). Proof: `pnpm test` with a new
   `src/auth.test.ts` — full flow on PGlite with a fake CIMD host: authorize → sign-in page → signed
   webhook "vincular X" → "sí" → status → consent → code → token (PKCE) → refresh rotation → reuse
   rejected; expired, foreign-cookie and disallowed-sender cases refused. Live: `curl -i
   https://wa.heywarren.app/mcp` shows 401 + header; both `.well-known` documents validate.
   Pages checked in a browser with the `ui` skill.
2. **Read tools.** Door + three read tools. Proof: an end-to-end test (JSON-RPC over HTTP with a real
   token) incl. cross-account isolation and expired/wrong-audience tokens; output validated against a
   closed copy of each schema. Live: `claude mcp add --transport http warren https://wa.heywarren.app/mcp`
   in Claude Code, sign in, ask for this month's total, and compare with `pnpm` summary from the DB.
3. **Writes.** `applyCall` extraction (no behaviour change: full suite + `pnpm eval:scenarios --split
   all` at the previous 180/182 bar, 0 silent), `013_channel`, six write tools, and "desconectar"
   on WhatsApp (code command) revoking that account's refresh tokens and consents. Proof: tests for
   each write, MCP-write-then-WhatsApp-undo, stale-id refusals, conversation window ignores MCP rows.
   Live: Ticiano adds the connector in claude.ai (replacing the dead v0 "Warren" connector), logs a
   café from Claude, sees it on WhatsApp, undoes it with "deshacer".

## Open questions

1. **New packages.** Beyond the two approved, this needs `@better-auth/mcp`, `@better-auth/cimd`
   (same family; `@better-auth/oauth-provider` comes with them), `@modelcontextprotocol/node` (the
   node adapter of the approved SDK) and `kysely-postgres-js` (lets better-auth use our existing
   driver instead of adding `pg`). OK?
2. **Writes over MCP in this slice** (slice 3 above), or read-only first and writes after the overhaul?
   I recommend writes now: they share every guard, and "deshacer" on WhatsApp covers a client mistake.
3. **The URL people type.** `https://wa.heywarren.app/mcp` needs no DNS work, but a connector URL is
   hard to change later. If you'd rather `https://heywarren.app/mcp` (apex freed by the v0 teardown),
   point it at Railway and tell me.
