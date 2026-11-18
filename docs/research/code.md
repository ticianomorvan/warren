> Research as of 2026-11-17; not legal advice.

# Warren open source launch: code research

Date: 2026-11-17. Scope: seven engineering questions. Repo read: the repository root (README, `packages/db/src/schema.ts`, `packages/db/drizzle/*.sql`, `packages/core/src`, `apps/web/lib`).

Tags: VERIFIED = primary page or file read today (URL given). LOCAL = I ran it today on the repo's pinned versions (Node 24.14.1, PGlite 0.5.16, drizzle-orm 0.45.4). UNVERIFIED = not read from a primary source.

## Recommendations

1. **Row-level security on every tenant table.** Add `user_id text not null` and policies in a new migration after `0007_notice_rules.sql`; mirror them in `packages/db/src/schema.ts` with `pgPolicy` and `.enableRLS()`. The app already connects as `warren_app` (non-owner, no BYPASSRLS), so policies bind it without `FORCE`. Select and insert policies on append-only tables. An update policy only on `movement`.
2. **One door for queries.** Add `asUser(db, userId, fn)` to `packages/db/src/client.ts`: open a transaction, run `select set_config('app.user_id', $1, true)`, run `fn`. Export only this and `asSystem`. Make `db()` in `apps/web/lib/db.ts` return the wrapper, so a query without a user cannot be written. Never use `SET` or `set_config(..., false)` on the Neon pooler.
3. **Per-user keys, not global ones.** `blob_file`, `inbound_mail`, `account`, `account_identifier`, `mail_delivery` use global primary keys. Change them to `(user_id, ...)`. Otherwise user B inserting a mail user A already stored hits a key conflict and learns it exists (PostgreSQL documents this covert channel). Prefix blob paths with the user id in `apps/web/lib/raw-store.ts`.
4. **Per-user hash chain.** Rewrite `event_chain()` (migration `0004_ledger.sql`): advisory lock on `hashtextextended(user_id, 0)` instead of the global `4201`, read the previous hash for that user, seed the first link with the user id. Add `unique (user_id, id)`. Add a `verifyChain(userId)` in `packages/db/src/ledger.ts`. I ran this on PGlite (see Q1).
5. **Tenancy test that cannot be skipped.** New `packages/db/test/tenancy.test.ts`: two users, `set local role warren_app` (PGlite connects as superuser, which ignores RLS), table-driven over every table. Also assert that every table in `public` with a `user_id` column has RLS enabled and at least one policy, read from `pg_policies`. A new table without a policy then fails CI.
6. **Mail intake needs a pre-user lookup.** The signed `To` names the owner, so the webhook must resolve user from address before any user context exists. Do it in `packages/core/src/mail/intake.ts` through a narrow `SECURITY DEFINER` function `user_for_address(text)` or a second role with one grant. Do not use a "system" GUC bypass inside policies.
7. **Erasure by key destruction plus deletion of derived rows.** PII sits in append-only tables: `event.payload`, `mail_parse.operation`, `movement_source.operation`, `notice_attempt.body`/`detail`, `mail_verdict.detail`, raw mail in Blob. Store these encrypted under a per-user data key kept in a new mutable `user_key` table (wrapped by a key from env/KMS). Hash the ciphertext so the chain survives. Erase = delete the key, derived tables (`movement`, `movement_source`), and blobs. Export = decrypt plus a manifest with the chain head.
8. **MCP tool surface.** New package `packages/mcp` (mounted by a route in `apps/web/app`). Short snake_case names with a domain prefix (`ledger_list_movements`, `ledger_get_movement`, `ledger_summarize`, `kit_get_profile`, `kit_list_facts`, `kit_get_principles`, `accounts_list`), each with `title`, `readOnlyHint: true`, `openWorldHint: false`, `outputSchema`. Add `search` and `fetch` only if ChatGPT deep research or company knowledge is a target. Keep write tools (if any) separate and annotated.
9. **MCP results.** Return `structuredContent` plus the same JSON as text. Amounts as decimal strings with `currency` and a `display` string built by one shared formatter. Cursor pagination (`limit` default 50, max 200, `next_cursor`, `truncated`, a hint on how to narrow). Hard cap per response well under 25,000 tokens. Errors as `isError: true` with a fix. Put the advice kit behind resources and tools, and prompts for user-run flows; no behavioural orders in tool descriptions.
10. **Evals in three tiers.** (a) Free, every CI run: in-process MCP client against a PGlite-seeded ledger, golden outputs, schema checks, size checks, cross-tenant check, `review_by` staleness check. (b) Free: recorded agent transcripts replayed in CI plus a grounding checker (`packages/core/src/eval/grounding.ts`) that fails if a number or date in an answer is not in a tool result. (c) Paid, nightly or by label: promptfoo with its MCP provider, cached, with a spend cap.
11. **Redaction command.** `scripts/mail-redact.ts` (`pnpm mail:redact in.eml`) with fixtures under `packages/core/test/fixtures/mail/<bank>/<template>/`. Reuse `fakeCbu` and `fakeCuit` from `packages/core/test/fixtures.ts`. Parser tests read the redacted body. Verification tests re-sign the redacted mail with `makeSigner` from `packages/core/test/helpers.ts`, using the d=, s= and h= recorded in a sidecar file. Add a fixture lint in CI.
12. **Logs and error reports without PII.** Today `apps/web/lib/notify.ts` line 25 logs `a.detail` from Kapso (provider text, may hold a phone number); the other `console.error` calls log only `error.message`, which can still echo input. Log ids, codes and template names only. If Sentry is added: `dataCollection`/`sendDefaultPii` off, `httpBodies: []`, `beforeSend` that drops request data and `user`, no values in messages. Vercel Hobby keeps runtime logs 1 hour, Pro 1 day.
13. **Language.** Store `locale` per user. Use next-intl without locale routing (locale from user profile or cookie, via `i18n/request.ts`) for the web app. For notices and MCP text, replace the Spanish literals in `packages/core/src/notify/text.ts` with per-locale message functions in core, and format money with `Intl.NumberFormat`, which takes decimal strings exactly (LOCAL).
14. **Self-host seams.** Add a `MailSource` port next to `RawStore`: Resend webhook (today), IMAP poller with imapflow, optional `smtp-server` receiver, and file upload. Add S3 and filesystem `RawStore` implementations (the dev-only `fsRawStore` already exists in `apps/web/lib/raw-store.ts`). Guard `attachDatabasePool` in `apps/web/lib/db.ts` behind a Vercel check. Set `output: 'standalone'` and `outputFileTracingRoot` in `apps/web/next.config.ts`. Do not choose MinIO.

---

## Q1. Multi-tenant isolation with Postgres RLS and Drizzle

### What exists

- `warren_app` is created `nologin` in `0001_append_only_and_roles.sql`, granted select/insert (and update on `movement`). Triggers `forbid_mutation()` block update, delete and truncate on every append-only table for all roles, including the owner.
- `event_chain()` takes `pg_advisory_xact_lock(4201)` and reads the last row of the whole `event` table. That is one chain for all users and a global write lock.
- Tests use `new PGlite()` with `drizzle-orm/pglite` and migrate from `packages/db/drizzle`.
- `packages/db/src/client.ts` makes a `pg` Pool (max 5). `apps/web/lib/db.ts` wraps it with `attachDatabasePool`.
- README: `DATABASE_URL` is the pooled Neon host with role `warren_app`.

### Setting the user per transaction

- VERIFIED: `set_config(name, value, is_local)`. With `is_local = true` the value applies only to the current transaction. With `false` it lasts for the session. https://www.postgresql.org/docs/current/functions-admin.html
- VERIFIED: Neon's pooler runs PgBouncer in transaction mode. `SET`/`RESET`, `LISTEN`, SQL `PREPARE`, session advisory locks are unsupported. `SET LOCAL` inside a transaction reverts at the end. A plain `SET` can leak to another client because PgBouncer does not reset server connections. Protocol-level prepared statements need PgBouncer 1.22+. https://neon.com/docs/connect/connection-pooling
- VERIFIED: PgBouncer's own feature matrix lists `SET/RESET` as never supported in transaction mode and does not mention `SET LOCAL`. https://www.pgbouncer.org/features.html
- Pattern (LOCAL test below): connect as `warren_app` and set only a GUC. No `SET ROLE` is needed.

```ts
// packages/db/src/client.ts (sketch)
export async function asUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`) // bound parameter, no sql.raw
    return fn(tx)
  })
}
```

```sql
create policy event_select on event for select to warren_app
  using (user_id = current_setting('app.user_id', true));
create policy event_insert on event for insert to warren_app
  with check (user_id = current_setting('app.user_id', true));
```

- Fail closed: `current_setting('app.user_id', true)` returns NULL or an empty string outside a transaction that set it, so the policy matches no row (LOCAL: 0 rows returned).
- Drizzle's own RLS page shows a `createDrizzle` wrapper that runs inside a transaction, sets claims with `set_config(..., TRUE)`, then `set local role`, and calls `reset role` in `finally`. It builds SQL with `sql.raw` from token values; avoid that and bind parameters. VERIFIED https://orm.drizzle.team/docs/rls
- UNVERIFIED: that Drizzle's node-postgres `transaction()` pins one client for the whole callback. It uses `BEGIN` on a checked-out client in the 0.45 source I did not read; the LOCAL test used PGlite, which has one connection and proves nothing about pooling. Add a concurrency test on a real Neon branch before launch.

### Drizzle support (0.45.4)

- VERIFIED docs: `pgPolicy` (options `as`, `to`, `for`, `using`, `withCheck`), `pgRole(...).existing()`, role management is off unless `entities: { roles: true }` in drizzle-kit config, `crudPolicy` and `authenticatedRole` in `drizzle-orm/neon`. https://orm.drizzle.team/docs/rls
- VERIFIED docs: `.withRLS()` is the newer form; the page says `.enableRLS()` is deprecated in v1. LOCAL: the installed 0.45.4 type file has `enableRLS` and no `withRLS`. Use `.enableRLS()` now.
- VERIFIED docs: with `pgTable`, drizzle-kit turns RLS on when a table has policies and off when the last policy is removed.
- Neon's page: policies are declared in TypeScript, migrations run over a direct connection, and grants must be added separately. `authUid` reads `auth.user_id()` from JWT claims of the Data API. https://neon.com/docs/guides/rls-drizzle
- Fit for Warren: `crudPolicy` emits insert, update, delete and select policies. Warren wants select and insert only. Write `pgPolicy` per command. Declare `pgRole('warren_app').existing()` because the role is created by hand-written SQL.

### Interaction with existing triggers and grants

- VERIFIED: table owners and superusers bypass RLS unless `FORCE ROW LEVEL SECURITY` is set; `BYPASSRLS` always bypasses; no policy means default deny; `TRUNCATE` and `REFERENCES` are not subject to RLS; foreign key and unique checks bypass RLS. https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- LOCAL: the `forbid_mutation` triggers still fire under RLS. An `update` by a policy-less role fails earlier with `permission denied` from the grant. Grants stay the first wall; RLS is the second.
- LOCAL: a `before insert` chain trigger that does `select ... from event where user_id = new.user_id` runs under the caller's RLS view, which is what a per-user chain needs. No `SECURITY DEFINER` needed.
- Scripts that run as the owner (`pnpm ledger:accounts`, `mail:parse-pending`) bypass RLS. Either run them as a role subject to policy through `asUser`, or accept that and say so in the README.
- Global unique constraints (`blob_file.sha256`, `event.id`, `account_identifier(scheme,value)`) leak existence across users (PostgreSQL documents this covert channel). Make them per-user.
- Content-addressed Blob paths dedupe across users. That blocks per-user erasure and per-user keys. Prefix with the user id.
- Two users can share a counterparty CBU legitimately. `account_identifier` primary key `(scheme, value)` would refuse the second user.

### LOCAL test on PGlite (run today)

Script: two users, table with chain trigger, RLS, `warren_app` role. Output:

```
A sees [ { user_id: 'A', seq: 1 }, { user_id: 'A', seq: 2 } ]
B sees [ { user_id: 'B', seq: 3 } ]
B insert as A: new row violates row-level security policy for table "ev"
B update: permission denied for table ev
no user: 0
after commit GUC: [{"v":""}]            -> empty string, not NULL, after the transaction ends
chains: A:e5d5f7c1, A:fda736ad, B:e5d5f7c1   -> same first hash for same payload
superuser sees all [ { count: 3 } ]
```

Reading: isolation holds; cross-user insert is refused; no context returns nothing. The identical first hash for A and B shows why the first link must be seeded with the user id (otherwise equal payloads give equal chains across users).

### Test plan (pglite)

1. Migrate, create users A and B, insert through `asUser` for each.
2. Table-driven: for each table with `user_id`, `select count(*)` as A equals A's rows, as B equals B's.
3. B tries `insert ... user_id = 'A'`, expect RLS error. B tries `update`/`delete`, expect error.
4. No `asUser` call (plain connection as `warren_app`): expect 0 rows.
5. Chain: A and B each append; `verifyChain(A)` and `verifyChain(B)` pass; tamper test through the owner with triggers disabled fails verification for A only.
6. Meta test: every `public` table with `user_id` has `relrowsecurity` true and a row in `pg_policies`.
7. Concurrency: two parallel `asUser` calls on a pool of one, to see context does not leak (real Postgres, not PGlite).

### Not yet known

- Whether Neon lets the owner role create `BYPASSRLS` roles. UNVERIFIED. Avoid needing it.
- Cost of policies at scale. Index `user_id` first on every table (e.g. `(user_id, seq)`).

---

## Q2. MCP tool design

### Protocol facts (VERIFIED, spec page for 2026-07-28)

Sources: https://modelcontextprotocol.io/specification/latest/server/tools , `/resources`, `/prompts`.

- Names: 1 to 128 characters, case-sensitive; allowed: letters, digits, `_`, `-`, `.`; unique per server. Clients that merge servers may collide, so a prefix is recommended.
- A tool has `title`, `description`, `inputSchema` (must be a JSON Schema object; for no parameters use `{"type":"object","additionalProperties":false}`), optional `outputSchema`, `annotations`.
- Structured output: if `outputSchema` is set, the server MUST return conforming `structuredContent`; a tool that returns it SHOULD also return the JSON in a text block.
- Errors: protocol errors are JSON-RPC errors; tool execution errors (bad date, out of range, business rule) go in the result with `isError: true` so the model can retry. Servers MUST validate input, rate limit, sanitize output.
- `tools/list` supports pagination and caching; order should be deterministic (helps prompt caching); the set may vary by authorization but not by connection.
- Annotations are hints and clients MUST treat them as untrusted unless the server is trusted.
- Resources are application-driven (host decides how to attach them); prompts are user-controlled (slash-command style). Tools are model-controlled.
- Resource not found: JSON-RPC error `-32602`; an empty `contents` array for a missing resource is forbidden.
- Annotation defaults (VERIFIED, draft schema.ts https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/draft/schema.ts): `readOnlyHint` false; `destructiveHint` true (only meaningful when not read-only); `idempotentHint` false; `openWorldHint` true. So a read-only tool must say `readOnlyHint: true` and `openWorldHint: false` explicitly.
- The current spec is stateless (no `initialize`, per-request `_meta`). `mcp-handler` 2.4.0 serves 2026-07-28 natively and falls back to stateless Streamable HTTP for 2025-era clients; no Redis. VERIFIED https://github.com/vercel/mcp-handler (README). Test both eras.
- Better Auth's MCP plugin is current, built on its OAuth 2.1 provider, DCR off by default, `requireMcpAuth` wrapper, scope enforcement with 403 `insufficient_scope`. VERIFIED https://www.better-auth.com/docs/plugins/mcp

### Anthropic

- VERIFIED https://www.anthropic.com/engineering/writing-tools-for-agents : build a few tools for real workflows, not one per endpoint; namespace with shared prefixes and test prefix vs suffix; return names rather than opaque ids (ids too when needed for follow-up); offer a `response_format` of concise or detailed; paginate, filter, truncate with sensible defaults and tell the agent how to narrow; write errors that say what to do, with an example; unambiguous parameter names (`user_id` not `user`); describe tools like onboarding a new colleague; use annotations for destructive and open-world.
- VERIFIED https://claude.com/docs/connectors/building.md : limits: about 150,000 characters per tool result on claude.ai and Desktop; 25,000 tokens in Claude Code (raise with `MAX_MCP_OUTPUT_TOKENS`); tool call timeout 240 seconds on claude.ai and Desktop. Claude supports tools, prompts, resources, text and image results. Not supported: resource subscriptions, sampling, draft capabilities. Streamable HTTP recommended; SSE being deprecated. OAuth callback `https://claude.ai/api/mcp/auth_callback`; DCR supported.
- VERIFIED https://claude.com/docs/connectors/building/review-criteria.md (directory review, useful as a bar even for a custom connector): split read and write tools (a catch-all `api_request` is rejected); every tool needs `title` and `readOnlyHint` or `destructiveHint`; names at most 64 characters; descriptions state what and when and must match behaviour; descriptions must not instruct Claude (no "always call X", no hidden or behavioural instructions); errors must be specific; responses sized to the task; connectors that transfer money are not accepted. Warren is read-only, so it is in scope.
- UNVERIFIED (issue-tracker reports, not Anthropic docs): a cap on total tools across connectors, and a silent drop of tools with very large input schemas. Keep schemas small.

### OpenAI

- VERIFIED https://developers.openai.com/apps-sdk/build/mcp-server : one tool per action; descriptions say when to use the tool; metadata drives selection; `readOnlyHint` only when the tool cannot change state; `openWorldHint` false for a bounded private store; annotations do not replace server-side authorization; `structuredContent` for data the model reuses, `content` for text, `_meta` hidden from the model; keep secrets and needless personal data out of results; stable identifiers.
- VERIFIED https://developers.openai.com/apps-sdk/guides/optimize-metadata : name as domain plus action; start descriptions with "Use this when..."; state when not to use; document each parameter with examples and allowed values; build a golden prompt set with direct, indirect and negative prompts; measure precision and recall of tool selection; change one field at a time.
- VERIFIED https://developers.openai.com/api/docs/mcp : `search` (query string; returns `results` with `id`, `title`, `url`) and `fetch` (id; returns `id`, `title`, `text`, `url`) read-only tools for deep research and company knowledge; declare an output schema; return `structuredContent` and the same JSON as text; OAuth, with Client ID Metadata Documents preferred and DCR supported; ChatGPT asks confirmation before write actions. No numeric size or time limits stated on that page.
- UNVERIFIED: any output size limit for ChatGPT apps. Not found in the pages read.

### What makes agents call tools reliably (synthesis)

- Few tools, clear verbs, no overlap. The ledger has three reads (list, get, summarize); do not add per-field variants.
- Description opens with the use case and ends with a "do not use for" line.
- Every parameter has a description and an example; dates as `YYYY-MM-DD`; enums for `direction` (`in`, `out`) and `currency`.
- Return the thing the model needs to quote: `display` money strings, account names, dates, and `as_of`. This cuts number mangling (see Q3).
- A `summarize` tool does the arithmetic in code (totals, by month, by counterparty) so the model never adds numbers. This matches the README rule.
- Test selection with a golden prompt set in both Spanish and English (see Q3 tier c).

### Warren application

- Advice kit: expose as three read tools and also as resources (`warren://kit/profile`, `.../principles`, `.../facts`), because hosts may not attach resources on their own. Each fact carries `review_by`, and the tool marks `stale: true` when past it.
- Prompts for user-run flows (for example `monthly_review`), not for hidden steering.
- Pagination cursor = opaque base64 of the last `seq`; the server re-checks the user on every call and never trusts the cursor for access.
- Size: default page of 50 movements; each movement is about 400 bytes as JSON, so about 20 KB. That is far below both limits. Cap `limit` at 200 and say so in the schema.

---

## Q3. Evaluating advice quality without a model in every CI run

### Facts

- VERIFIED https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents : code-based graders are cheap, objective and reproducible; model graders need calibration against humans; grade what the agent produced, not the path; verify outcomes in the environment; check that answers are grounded in tool results; start with 20 to 50 tasks from real failures; isolate each trial; use pass^k when consistency matters; regression evals sit near 100%.
- VERIFIED https://www.promptfoo.dev/docs/integrations/mcp/ : an `mcp` block in a provider config can launch a local server (`command`, `args`) or connect to a `url`; default timeout 60 s. https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/ lists `is-json` with schema, `contains-all`, `regex`, `javascript` (custom function), `tool-call-f1`, and `trajectory:tool-used`, `trajectory:tool-args-match`, `trajectory:tool-sequence`, `trajectory:step-count` (these need tracing).
- VERIFIED https://www.promptfoo.dev/docs/configuration/caching/ : provider-response cache on by default, disk at `~/.promptfoo/cache`, 14-day TTL, `--no-cache` to disable; for CI the page only recommends `PROMPTFOO_CACHE_TYPE=disk` and `PROMPTFOO_CACHE_PATH` for external test frameworks. Key = provider, prompt digest, config, vars. Key format may change between versions.
- VERIFIED licences by GitHub API today: promptfoo MIT (0.125.1, 2026-10-25), Inspect AI MIT, MCP Inspector licence not asserted by GitHub (NOASSERTION).
- VERIFIED https://modelcontextprotocol.io/docs/tools/inspector : the Inspector has a CLI mode for scripted `tools/list` and `tools/call` with JSON output, meant for CI. It needs Node 22.23.4+, 24.22.1+ or 26.12.1+ (this machine runs 24.14.1, so check the CI image).
- VERIFIED https://inspect.aisi.org.uk/tools-mcp.html : Inspect can use remote MCP servers (`mcp_server_http`) and narrow tools (`mcp_tools`); header values go to the model provider and are not stored in the log. The page does not cover mock models or log replay. Inspect is a Python tool (UNVERIFIED on that page); Warren is TypeScript, so promptfoo fits better.

### Recommended setup

**Tier a. Tool contract tests (free, every CI run).**

- Build the MCP server with an in-process client (SDK client over an in-memory transport) against a PGlite ledger seeded from the synthetic fixtures. No network, no model.
- Assert: each tool's output validates against its `outputSchema`; golden snapshots of outputs; response size under a budget; pagination returns every row once; user B gets nothing of user A; an expired kit fact comes back with `stale: true`; errors are `isError` with a hint.
- Run the same checks through the MCP Inspector CLI in one smoke job to catch transport and OAuth wiring.

**Tier b. Grounding checker and transcript replay (free, every CI run).**

- Grounding checker, pure function in `packages/core/src/eval/grounding.ts`: input = final answer text plus the tool results of that run. Extract every money amount, percentage, count and date from the answer (accept es-AR `1.234,50` and en `1,234.50`, ISO and spoken dates), normalise to decimals, and require each to appear in some tool result (after the same normalisation). Anything else is a fail. Allow a small allow-list (years, "3 months" given by the user in the question).
- Because Warren's rule is that code does the arithmetic, a derived number (a sum the model computed) must fail. A `summarize` result must contain it.
- Transcripts: a transcript is JSON `{question, locale, messages[], toolCalls[{name,args,result}], finalAnswer}`. Commit 20 to 50 of them under `evals/transcripts/`, recorded by a script (`pnpm eval:record`) from a real agent run against a synthetic ledger.
- CI replay does two things with no model: (1) re-execute each recorded tool call against the current server and compare to the recorded result, which catches tool drift; (2) run the grounding checker and shape checks on the recorded final answer. When a tool changes on purpose, re-record.
- Weakness: replay does not test that the model still chooses the right tool. That is tier c.

**Tier c. Live agent runs (paid, nightly or when a PR has a label).**

- promptfoo with the `mcp` provider against a seeded server; a fixed set of questions (es-AR and en), direct, indirect and negative prompts as in OpenAI's golden set.
- Asserts: `trajectory:tool-used`, `tool-call-f1`, `javascript` assertion that calls the grounding checker, `is-json` for any structured answer. Add a rubric-graded check on a small sample only, using a small model, with an "unknown" option.
- Run each question 3 times and require all three to pass (pass^3). Keep the cache on locally; in CI set a disk cache path and a spend cap. Publish the pass rate on the PR.
- Make failures turn into new transcripts: failing runs are reviewed, fixed, and added to tier b.

**Do not**: grade tone with a model on every PR; compare answer text to a golden answer; let the eval harness see real user data.

---

## Q4. Bank fixture corpus and a redaction command

### What other projects do

- VERIFIED (source file): beangulp's testing module writes and compares "expected" files per input document (`write_expected`, `compare_expected`, `write_expected_file(..., force=...)`), with account, date and name headers plus the printed entries. So the pattern is input file plus hand-checked expected output, with a `generate` step to create or refresh it. https://github.com/beancount/beangulp (file `beangulp/testing.py`, read through the GitHub API).
- Actual Budget: its contributing page only points to a Testing Guide and an AI usage policy. https://actualbudget.org/docs/contributing/ . No fixture-privacy rule found.
- Firefly III data importer: its contributing page and docs page returned 403 and 404 today. No evidence read.
- I found no primary source of an email-parser project with a redaction tool. Treat the design below as new work, not as copied practice.

### Facts that shape the design

- VERIFIED RFC 6376 https://www.rfc-editor.org/rfc/rfc6376.html : `bh=` is the hash of the canonicalised body (after `l=` limit); `h=` lists signed headers in order and may name headers that do not exist; the DKIM-Signature header itself is hashed last with `b=` empty; relaxed canonicalisation only folds whitespace, so any change to a signed header or to the body changes the hash. Redaction therefore always breaks the real signature, and a redacted mail can never verify against the bank's real key.
- LOCAL: `packages/core/test/helpers.ts` already has `makeSigner(domain, selector)` (RSA key, `mailauth.dkimSign`, relaxed/relaxed, `h=From:To:Subject:Date`) and `resolverFor(records)` for a fake DNS. `fakeCbu`, `fakeCuit` in `fixtures.ts` build valid check digits. The repo already states "No real mail or real account data belongs in this repository."
- `senders.ts` carries per-sender `requiredSignedHeaders` and notes (for example that the transfer sender does not sign Message-ID). That header shape is what verification tests need, not the real signature bytes.

### `pnpm mail:redact in.eml [--out dir]` design

Input is a raw `.eml`. Output is three files.

1. `name.eml`: redacted mail.
2. `name.meta.json`: facts about the original that tests need: DKIM `d=`, `s=`, `a=`, `c=`, the `h=` list, whether each signed header was present, header order, `Content-Type` tree, charset, transfer encodings, mail size class. No values.
3. `name.expect.json`: the operation the contributor says the parser must read (amount, CBU, names as the fake values). The contributor checks it by eye.

Steps:

1. Parse the MIME tree with `postal-mime` (already a dependency). Keep boundaries, part order, headers order and casing.
2. Decode quoted-printable and base64 parts and RFC 2047 words, redact, then re-encode with the same transfer encoding. Sensitive values often hide in encoded text.
3. Value discovery, in two passes:
   - Template pass: run the real template (`packages/core/src/mail/parse`) on the mail and collect the fields it read (amount, CBU, CUIT, names, reference). Each gets a replacement of the same shape: CBU through `fakeCbu` and CUIT through `fakeCuit` (valid check digits), amount with the same number of digits and the same separators, names from a fixed list keeping case and word count, reference digits random with the same length.
   - Generic pass: patterns for 22-digit CBU/CVU, 11-digit CUIT/CUIL, 7 to 8 digit DNI, emails, phones, card last four, IBAN-like strings, IPs, money (`\$\s?\d{1,3}(\.\d{3})*,\d{2}`, `US\$`), dates of birth, and every URL (replace host with `example.invalid`, drop path and query).
4. One mapping per run: the same real value always gets the same fake value, so own-transfer matching still works in the fixture. The map is held in memory and never written.
5. Headers: keep names, order and structure of `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version`, `Content-Type`. Replace addresses with `owner@example.com` and the bank address with the real bank address only if it is a public sender listed in `senders.ts`, otherwise a placeholder. Drop `Received`, `X-*`, tracking and `Authentication-Results` content except a placeholder line each. Keep `Date` shifted to a fixed year with the same format.
6. DKIM-Signature: keep the tag layout (`v a c d s h t`), set `b=` and `bh=` to a fixed placeholder, mark the file as unsigned in meta. Do not keep the original `b=`: it is a fingerprint of the original mail.
7. Images and links: drop `src` and `href` values, keep tag and class.
8. Fail closed: after writing, re-scan the output against every original sensitive value held in memory (plain, decoded, upper and lower case, with and without separators) and against the generic patterns. If any hit, delete the output and exit non-zero. Print a report of categories and counts only, never values.
9. `--review` prints a side-by-side of structure only (tag tree with text replaced by `...`) so the contributor can check nothing odd remains.

### How tests split

| Layer                | Input                                                                                                          | Proves                                                                                                            | Needs real signature         |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Parser tests         | redacted `.eml` HTML body plus `expect.json`                                                                   | templates read fields from the real layout                                                                        | no                           |
| Verification tests   | redacted mail re-signed with `makeSigner` using `meta.json` (same d, s, h, canonicalisation) and `resolverFor` | sender policy accepts the real header shape; rejects wrong signer, missing signed header, tampered body, wrong To | no (synthetic key)           |
| Key record tests     | the bank's public DKIM TXT record, committed as text                                                           | `minKeyBits`, key parsing                                                                                         | no (public data)             |
| Real-signature smoke | maintainer's private `.data/` mails through `pnpm mail:verify --any-date`                                      | the live bank key still verifies the real mail                                                                    | yes, local only, never in CI |

### Contributor safety

- Issue template says: never paste or attach a raw mail; run `mail:redact` and attach its output; offer a private channel (GitHub private security report or an `age`-encrypted file) for cases where the redaction misses a layout.
- CI `fixture-lint` job over the fixtures directory: only `example.invalid`, `example.com` and the listed bank domains; `b=` and `bh=` equal the placeholder; no 22-digit or 11-digit runs that fail the fake check-digit helpers (real ones would pass a valid check digit, so also require the digits to match a known fake prefix like `0170099`); no `Received` lines; no base64 images.
- PR template checkbox: "I ran `mail:redact` and read the `--review` output."

---

## Q5. Privacy engineering for a hosted finance app

### Facts

- VERIFIED https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790/texto (Ley 25.326): consent must be free, express and informed (art. 5); security and confidentiality measures (art. 9); transfer of personal data to countries or bodies without adequate protection is prohibited with exceptions (art. 12); access is free at intervals of no less than six months (art. 14); the controller must act on rectification or suppression within five working days of the claim, else the data subject can go straight to habeas data (art. 16); files must be registered (art. 21, public files and private files meant to give reports; whether Warren must register is a legal question).
- VERIFIED https://neon.com/docs/introduction/regions : `aws-sa-east-1` (São Paulo) exists. Object storage is not listed there for that region, and the repo already pins Vercel to `gru1`.
- VERIFIED https://neon.com/docs/introduction/branching : history window defaults to 6 hours (Free) and 1 day (paid), up to 7 days (Launch) or 30 days (Scale). Deleted rows live in history until the window passes. The page does not say how fast lowering the window purges history.
- VERIFIED https://verraes.net/2019/05/eventsourcing-patterns-throw-away-the-key/ : crypto-shredding is one key per subject, deleted on request, so every copy and backup becomes unreadable. Caveats there: projections that hold decrypted data still hold it; and a reader's lawyer says encrypted personal data may still count as personal data, so the "forgettable payload" variant (store the PII outside the log, keep only a reference) may be the safer legal fit. Not legal advice.
- Secondary only (UNVERIFIED primary text; the EDPB PDF could not be read as text): EDPB Guidelines 02/2025 on blockchain, now at version 2.0 of July 2026, say a hash can still be personal data, advise keeping personal data off the immutable store, and accept making data unidentifiable by erasing off-chain parts or destroying keys. Source list from search: https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf . A hash chain in Postgres is not a blockchain, but the reasoning on hashes carries over.
- VERIFIED https://vercel.com/docs/vercel-blob/security : all Blob files are AES-256 encrypted at rest; private stores need authentication for every read and write; OIDC is preferred over the long-lived `BLOB_READ_WRITE_TOKEN`.
- VERIFIED https://vercel.com/docs/observability/runtime-logs : runtime logs record request path and search params; retention Hobby 1 hour, Pro 1 day, Pro or Enterprise with Observability Plus 30 days; each request up to 256 lines and 1 MB. The page does not describe a way to delete logs or redact fields.
- VERIFIED https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/ : the SDK `dataCollection` option (since 10.57.0) collects user identity and request and response bodies by default and scrubs only keys on a sensitive list; `httpBodies: []` turns body capture off; `beforeSend`, `beforeSendLog`, `beforeSendSpan`, `beforeBreadcrumb` can edit or drop; `x-forwarded-for` is not scrubbed by default; `Sentry.setUser()` data is always sent. `sendDefaultPii` is deprecated in v10.
- VERIFIED https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/ : server-side scrubbing is on by default; it matches card-number-like values and keys such as password, secret, token; breadcrumbs keep category; geo is still derived from IP unless a rule removes it. It does not say names or free text are scrubbed.

### Where PII lives today

Append-only or derived, all keyed by nothing user-specific yet:

| Table or store                              | PII in it                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Blob raw mail (`blob_file`, `inbound_mail`) | whole mail: names, CBU, CUIT, amounts, signed To address                  |
| `mail_verdict`                              | `from_address`, `subject`, `detail`                                       |
| `mail_parse.operation` (jsonb)              | counterparty name, CBU, CUIT, amount, reference                           |
| `event.payload` (jsonb)                     | same operation data                                                       |
| `movement`, `movement_source.operation`     | same, plus owner's account labels                                         |
| `account`, `account_identifier`             | account names and CBUs                                                    |
| `notice_attempt.body`, `detail`             | the sent WhatsApp text and provider detail (may contain the phone number) |

### Recommended design

1. **Split identity from facts.** Event rows keep a non-identifying skeleton in clear (`seq`, `user_id`, `kind`, `subject`, hashes, timestamps). Everything identifying goes in an encrypted blob column.
2. **Per-user data key.** A new mutable `user_key(user_id, wrapped_dek, created_at)` outside the append-only set. AES-256-GCM, a random 96-bit nonce per row, the row's `(user_id, seq)` as associated data. The data key is wrapped by a key from env (hosted: a KMS or Vercel secret; self-host: file). Rotate the wrapping key without re-encrypting events.
3. **Chain over ciphertext.** Compute `payload_sha256` over the stored ciphertext bytes, not the plaintext JSON. The chain stays verifiable after erasure and the hash is no longer a low-entropy fingerprint of an amount and CBU. This changes `event_chain()` from `payload::text` to a `bytea` column.
4. **Derived rows are deletable.** `movement` and `movement_source` are rebuildable. Give a dedicated `warren_eraser` role delete on them (or a `SECURITY DEFINER` function) and run it in the erasure job. The append-only triggers on those tables currently only cover `event` and intake tables, so this works for `movement` today; `movement_source` has no trigger.
5. **Erasure job** for user U, in order: delete `user_key` row; delete derived rows; delete blobs under `u/<U>/`; delete `notice` text columns by making `notice_attempt.body` encrypted too; delete the user and sessions in Better Auth tables; write a tombstone row (`user_id`, date, chain head hash) so the log shows when and what was shredded. Neon history keeps the wrapped key for up to the history window, so state in the policy: "erased within N days of the request, where N is the history window".
6. **Export.** `GET /export` streams JSON Lines of decrypted events, plus movements as CSV, plus a manifest with the chain head and a `verify-export` command in the repo that recomputes the chain from the exported ciphertext hashes. Art. 14 allows a free request every six months; rate limit to match, and do not charge.
7. **Response time.** Art. 16 gives five working days for suppression. Make the erasure job self-serve in settings so the clock is moot.
8. **Retention.** Raw mail: keep only as long as re-parsing needs it; offer a per-user setting (for example 13 months) and a job that deletes older blobs; events are kept until erasure. Sessions and OAuth tokens follow Better Auth expiry. Delivery logs from Kapso are in `notice_status` (no PII beyond wamid).
9. **Logs and errors.**
   - Log ids, template ids, status codes, durations. Never log mail fields, names, amounts, CBU, `a.detail` text from Kapso, or the `To` address.
   - Do not put values in URLs (Vercel logs record path and search params).
   - Sentry (if used): `dataCollection` with `httpBodies: []`, `userInfo` false or only an opaque id, `beforeSend` dropping `request.data`, `request.cookies`, `user.email`, `extra`; `beforeBreadcrumb` returning null for console and fetch breadcrumbs; add `forwarded` to the denylist; region choice (EU or US) is a cross-border transfer decision under art. 12.
   - Add a unit test that throws an error whose message contains a fake CBU and checks the `beforeSend` output has none.
10. **Raw mail encryption.** Blob is encrypted at rest by Vercel, but anyone with the store credentials reads plaintext. Encrypt mail bytes with the user's data key before `put` (envelope: store `nonce || ciphertext`). The SHA-256 in `blob_file` should then be of the ciphertext (or a keyed hash), otherwise the hash of known bank mail is a confirmation oracle. Verification re-reads and decrypts first.
11. **Hosted vs self-host.** The same code path; only the key wrapper differs.

Open legal choice (needs counsel): crypto-shredding vs forgettable payload. Design above works for both, since PII is already out of the clear columns; forgettable payload would store the ciphertext outside the chain and keep only its hash in the chain.

---

## Q6. Spanish and English

### Facts

- VERIFIED https://nextjs.org/docs/app/guides/internationalization (updated 2026-11-06): the built-in approach is `proxy.js` for locale negotiation and redirect, an `app/[lang]` segment, per-locale dictionaries loaded on the server, `next/root-params` to read the locale anywhere on the server (not in Client Components, Server Actions or Route Handlers), `generateStaticParams` for static locales. The page lists libraries: next-intl, next-international, next-i18n-router, paraglide-next, lingui, tolgee, next-intlayer, gt-next.
- VERIFIED https://next-intl.dev/docs/getting-started/app-router : plugin `createNextIntlPlugin()`, request config at `./i18n/request.ts`, `getTranslations` for Server Components, and a mode without locale in the URL where the locale comes from a cookie or user data read in `i18n/request.ts`. The page does not state Next.js version support.
- LOCAL `npm view`: next-intl 4.15.1, MIT, peer `next` includes `^16.0.0`. Lingui 6.12.0, MIT. Warren pins Next 16.4.6.
- LOCAL (Node 24.14.1, ICU 78.2):
  - `new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS'}).format('1500.00000000')` gives `$ 1.500,00`.
  - It accepts a decimal string with full precision: `'12345678901234567.89'` gives `$ 12.345.678.901.234.567,89`; the same value as a JS number gives `...568,00` (float loss). So pass the stored string, never `Number()`.
  - USD in `es-AR` gives `US$ 1.234.567,50`; in `en` gives `$1,234,567.50`. ARS in `en` gives `ARS 1,234,567.50` (use `currencyDisplay: 'narrowSymbol'` for `$1,500.50`).
  - `es-AR` groups four-digit numbers (`1.234`); this is not true of `es-ES`.
  - Dates: `es-AR` `dateStyle: 'medium'` gives `14 nov 2026, 2:09 p. m.` and `en` gives `Nov 14, 2026, 2:09 PM`. Day-month: `14/11` vs `11/14`. Always pass `timeZone: 'America/Argentina/Buenos_Aires'` for display of instants; ledger dates are plain `date` values and need no zone (`timeZone: 'UTC'` when formatting a `Date` made from `yyyy-mm-dd`).
  - The `es-AR` currency output uses a no-break space after `$`; the current `formatMoney` in `packages/core/src/notify/text.ts` uses a normal space. A test that compares strings will see the difference if the formatter is swapped.

### Recommendations

- Web app: next-intl without locale routing. Locale = `user.locale` for signed-in pages, `Accept-Language` for the marketing page (`@formatjs/intl-localematcher`, as the Next.js guide shows). If SEO for the landing page matters, add `/en` and `/es` routes only for public pages (then use `[lang]` and `next/root-params` for those).
- Message catalogs (`es-AR.json`, `en.json`) live in a package both web and core import, so notices and MCP text share them. Use ICU messages for plurals (`Intl.PluralRules` is native). Keep catalogs small; type the keys.
- Notices (`packages/core/src/notify/text.ts`): today `noticeLines` hard-codes Spanish ("Transferencia entre tus cuentas", "a"/"de"). Change to `noticeLines(m, locale)` using catalog entries. Money and dates from one `formatMoney(amount, currency, locale)` built on `Intl.NumberFormat` with the decimal string. Keep the rule "plain code builds the text; no model".
- WhatsApp approved templates are per language and registered with Meta; store `locale` on the notice row so a resend picks the right template. UNVERIFIED: Kapso's template-language handling. Not read.
- MCP tool output: return both machine fields (`amount: "1500.00"`, `currency`, `date`) and `display` strings in the user's locale, from the same formatter. Tool names and schema field names stay English and stable; only `display` and error hints are localised. The agent answers in the user's language by itself.
- Test: a table of `(amount, currency, locale) -> expected` strings including NBSP, 4-digit grouping, large values; and a test that `Intl.NumberFormat` receives strings, never numbers (lint rule or a wrapper that throws on `number`).
- Docs: README and docs site in both; keep one source file for bank names and template ids that is language-neutral.

---

## Q7. Self-hosting viability

### MinIO and object storage

- VERIFIED https://github.com/minio/minio (README, plus GitHub API today): the repository is archived (archived 2026-04-25; last push 2026-04-24); "THIS REPOSITORY IS NO LONGER MAINTAINED"; licence AGPL-3.0; "The MinIO community edition is now distributed as source code only"; no pre-compiled binaries for the community version; old binaries remain but get no updates; install paths are `go install` (Go 1.24+) or building the Docker image from the Dockerfile; the vendor points to AIStor Free (free licence, standalone) and AIStor Enterprise. Conclusion: do not recommend MinIO for a new project.
- VERIFIED by GitHub API today: Garage (`deuxfleurs-org/garage`) AGPL-3.0, pushed 2026-11-17, not archived (the GitHub repo has no "latest release" entry; releases are on the project's own site). SeaweedFS Apache-2.0, release 4.54 on 2026-11-16. RustFS Apache-2.0, release 1.0.6 on 2026-11-15 (UNVERIFIED maturity; not read).
- VERIFIED https://garagehq.deuxfleurs.fr/ : S3-compatible; page stresses multi-site clusters with three-way replication; minimum 1 GB RAM and 16 GB disk. Single-node use is not described there (UNVERIFIED).
- Recommendation: the default self-host `RawStore` is the plain filesystem on a volume (the repo already has `fsRawStore`), because Warren stores small immutable files and one node is the common case. Add an S3 `RawStore` (`@aws-sdk/client-s3`) for people who already run Garage, SeaweedFS or a cloud bucket. Document both; mention MinIO only as "archived, not recommended".
- Keep `RawStore` keyed by `u/<user_id>/<sha256>` and encrypted (Q5), so the store never needs its own access control beyond the volume.

### Next.js 16 in Docker

- VERIFIED https://nextjs.org/docs/app/getting-started/deploying : Node.js server and Docker both support all features; template "Docker Standalone Output" in `vercel/next.js` `examples/with-docker`.
- VERIFIED https://nextjs.org/docs/app/api-reference/config/next-config-js/output : `output: 'standalone'` writes `.next/standalone` with a minimal `server.js`; `public` and `.next/static` are not copied by default (copy them); `PORT` and `HOSTNAME` env vars; in a monorepo set `outputFileTracingRoot` to the repo root, because the app directory is the default root and files outside it are not traced.
- Warren specifics (LOCAL): `apps/web/next.config.ts` has `transpilePackages` for `@warren/core` and `@warren/db` (TypeScript source) and `serverExternalPackages: ['mailauth','pg','linkedom','postal-mime']`. In a standalone build, check that these externals land in the traced `node_modules` (add `outputFileTracingIncludes` if not). UNVERIFIED until a build is run.
- VERIFIED https://nextjs.org/docs/app/guides/self-hosting : put a reverse proxy in front; env vars are build-time only for `NEXT_PUBLIC_*` and read at request time otherwise (use `connection()` or other request APIs), so one image works in many environments; multiple instances need the same `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, a `deploymentId`, and a shared cache handler; one instance with a disk needs none of that. Streaming needs proxy buffering off (`X-Accel-Buffering: no`).
- Image optimisation works with `next start`; on glibc Linux watch sharp memory (page note).

### `@vercel/functions` and `after()`

- LOCAL: `@vercel/functions` is used in one place, `attachDatabasePool(pool)` in `apps/web/lib/db.ts`. There is no `waitUntil` call. Notices are sent inline: `if (result.status === 200) await sendOwedNotices()` in `apps/web/app/api/inbound/resend/route.ts`.
- VERIFIED https://nextjs.org/docs/app/api-reference/functions/after : `after` is stable since 15.1.0; works in Server Components, Server Functions, Route Handlers and Proxy; runs after the response is finished, even on errors; supported in Node server and Docker; on serverless it relies on a `waitUntil`; `cookies()` and `headers()` can be read inside it only in Route Handlers and Server Functions.
- VERIFIED https://nextjs.org/docs/app/guides/self-hosting : `after` is fully supported with `next start`; on `SIGINT` or `SIGTERM` the server finishes in-flight requests and pending `after()` callbacks; give a drain of 10 to 30 seconds (Docker `stop_grace_period`).
- Recommendation: replace the inline `await sendOwedNotices()` with `after(() => sendOwedNotices())`. It is portable (Vercel uses `waitUntil` underneath, self-host waits on shutdown) and removes notice sending from the webhook's latency. Keep the existing "notice owed" outbox as the safety net: if the process dies, the next mail or a timer sends it. Add a timer or cron-style `flushNotices` for self-host, since there is no Vercel cron.
- `attachDatabasePool`: only call it when `process.env.VERCEL` is set; otherwise create a plain Pool with a normal idle timeout and end it on `SIGTERM`.

### Mail without an open port 25

- VERIFIED https://imapflow.com/docs/guides/fetching-messages : `fetchOne(seq, { source: true })` returns the full RFC 822 message as a Buffer, fetched with `BODY.PEEK[]` (does not set `\Seen`); `download` streams "raw bytes without any decoding"; fetch by UID with `{ uid: true }`. The page does not promise byte-for-byte identity beyond "raw bytes", and it does not mention IDLE or UIDVALIDITY handling (UNVERIFIED).
- LOCAL `npm view`: imapflow 2.12.1 MIT, updated 2026-11-15. smtp-server 3.21.6 licence MIT-0, updated 2026-11-16. mailparser 3.14.5, mailauth 8.1.0 (already used) MIT.
- DKIM and IMAP (reasoning, UNVERIFIED by test): DKIM covers only the headers in `h=` and the canonicalised body. The mailbox adds `Received`, `Delivered-To`, `Authentication-Results` on top; these are not signed, so they do not break the signature. The risk is a provider that rewrites bodies or line endings on storage. Relaxed canonicalisation tolerates whitespace and trailing blank lines, not content changes. How Gmail's forwarding filter and each IMAP provider store the message was not checked. Proof to ship: an integration test that feeds a synthetic signed mail through a real IMAP server container, fetches with imapflow `source: true`, and runs `verifyBankMail` on the bytes; and a doc line telling self-hosters to run `pnpm mail:verify` on one real fetched mail.
- IMAP poller design: a long-running worker (or a scheduled script) per mailbox; track `UIDVALIDITY` and last UID in a small table; fetch new UIDs, hash and store the raw bytes (same path as the Resend handler through the shared intake function), mark with a flag or move to a folder only after the database commit. Gmail needs an app password or OAuth; say so in docs.
- smtp-server: VERIFIED https://github.com/nodemailer/smtp-server : creates SMTP and LMTP servers in Node; `onData(stream, session, cb)` hands over the message as a stream; options `size` and `rejectOversized`, `disabledCommands`, `onConnect`. The page read did not cover STARTTLS setup, auth options, SPF or reverse-DNS checks, or any warning about not being a full MTA. A small receiver still needs a public MX, an open port 25, TLS, and spam handling, so make it optional and document it as advanced. IMAP polling or file upload are the easy defaults.
- Keep Warren's rule: a mail counts only when the bank's DKIM verifies and the signed To names the owner. Every source goes through the same `verifyBankMail`.

---

## Could not confirm

- Whether Drizzle's node-postgres `transaction()` pins a single pooled client end to end under Neon's PgBouncer. Proven only on PGlite (one connection). Needs a test on a real Neon branch.
- Whether Neon lets the owner role create BYPASSRLS roles; avoided in the design.
- Firefly III data importer and Actual Budget fixture and sanitising rules (pages blocked or silent). No email-parser project with a redaction tool was found.
- Inspect AI's support for mock models or log replay (page silent); promptfoo's ability to run with no model at all (page silent). The free tiers in Q3 do not rely on either.
- Output size limits for ChatGPT apps. Not found in OpenAI pages read. Claude limits are from Anthropic's page (150,000 characters hosted, 25,000 tokens in Claude Code).
- How Claude Code or Claude connectors treat `title`-less tools or very large `inputSchema`s (issue-tracker reports only).
- The EDPB blockchain guidelines primary text (PDF not readable here); only secondary summaries seen. Whether crypto-shredding meets Ley 25.326 art. 16 suppression, whether Warren must register a database (art. 21), and whether storing data with US vendors (Sentry, Vercel, Resend, Kapso) meets art. 12. All need counsel.
- Resend inbound retention, size limits and raw-message access (the introduction page is silent). Needed for the erasure policy.
- Vercel Blob region and whether Blob history or backups outlive a delete. Not read.
- Kapso template language handling for English notices.
- Whether the IMAP path (Gmail or other provider) keeps the signed bytes intact. Needs the integration test above.
- A standalone Docker build of `apps/web` (traced externals `mailauth`, `pg`, `linkedom`, `postal-mime`). Not built here; I did not change the repository.
- That `mcp-handler` 2.4.0 runs unmodified outside Vercel (it is stateless per its README, but I did not run it self-hosted).
