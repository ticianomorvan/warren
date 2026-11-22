FRAMEWORK BRIEF: what PostgreSQL and postgres.js provide for the turn/batch and undo question

Scope. Repo at commit 066eb87, postgres.js 4.1.1 (package.json `^4.1.1`). Docs read: `node_modules/postgres/README.md` and `types/index.d.ts`. PG docs are at https://www.postgresql.org/docs/current/. I did not run anything against a database. Every statement about how the repo uses a feature comes from reading code.

Shape of the data today. `inbound_message` is the sole batch identity. Every effect row points at it through `inbound_message_id`, `deleted_by`, `superseded_by`, `forgotten_by` or `cancelled_by`. Each of three tables (`movement`, `fact`, `reminder`) carries its own `restores` column and a partial unique index on it. `inbound_message.undoes` is unique. Pending questions are `pending jsonb` and `asked_ids bigint[]`. MCP writes insert a row with `wamid='mcp:<id>'` and `channel='mcp'` (src/mcp/write.ts:121).

1. Transactions and isolation
- PG: default is READ COMMITTED, where each statement sees a fresh snapshot. REPEATABLE READ gives one snapshot per transaction. SERIALIZABLE (SSI) aborts with 40001, and the app must retry. https://www.postgresql.org/docs/current/transaction-iso.html
- postgres.js: `sql.begin([options], fn)` reserves one connection, commits when `fn` returns and rolls back when it throws (README "Transactions", line 746). Options are a mode string such as `'isolation level repeatable read read only'`.
- Retry on 40001 or 40P01 is the app's job. The library has no retry helper.
- Repo: every write path is READ COMMITTED plus explicit locks. The only other isolation use is the MCP summary read (src/mcp/tools.ts:498).
- Decision for the council: with an explicit lock on a single per-account row, READ COMMITTED is enough, and SERIALIZABLE would need a retry wrapper. Today's locks are split across five advisory keys.

2. Row claiming with FOR UPDATE SKIP LOCKED
- PG: documented queue pattern, https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE. It is used as `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING`.
- App must write: lease expiry, attempt counting and stale takeover. Postgres has no visibility timeout.
- Repo: claim in src/store.ts:166-180 (the claim SQL, with stale-row recovery just above it). Reminder claims at src/reminders/send.ts:114 and :163, the latter as `FOR UPDATE OF r SKIP LOCKED`. All of these are correct for the pattern.
- Single replica means SKIP LOCKED mostly guards against overlapping ticks (the `setInterval` at src/server.ts:85) and a future second replica. It is cheap, so keep it.
- Per-sender ordering is not provided by SKIP LOCKED. Claims order by `id` only, so ordering rests on a single-worker loop, not on the database. A turn table could use a per-account advisory lock, or `NOT EXISTS` an earlier open row for the same account in the claim query.

3. Advisory locks
- PG: `pg_advisory_xact_lock(key1 int, key2 int)` is released at commit or rollback. https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS. Session-level locks are dangerous with a pool because they stay on the connection.
- Gotchas: key spaces are global to the database and are not enforced by anything. A different 32-bit-hash collision (`hashtext`, src/auth/link.ts:65) shares a lock by accident.
- Repo: five namespaces. 7203001 migrations (src/db.ts:25), 7203002 undo (src/undo.ts:86), 7203003 facts (src/facts.ts:70), 7203004 sign-in (src/auth/link.ts:65), 7203005 reminders (src/reminders/db.ts:58). Each is documented in a comment, and 7203005 is missing from the list at src/db.ts:19-20.
- The locks per account are really one concept ("one writer per account"). Undo takes 7203002 and then 7203005, and writes take 7203003 or 7203005. That is a lock-ordering hazard unless every path takes them in the same order.
- Alternative: lock one `account` row (`SELECT … FROM account WHERE id=$1 FOR UPDATE`). It is a real row, it makes FK semantics visible, and it is one lock, not a convention.

4. Partial unique indexes and constraints
- PG: https://www.postgresql.org/docs/current/indexes-partial.html. A unique index with a WHERE clause enforces "at most one live row per key" and "at most one restore of X".
- Repo, used well: `fact_live_key_idx` (account, kind, key) where live, `*_restores_idx` on all three tables, and `inbound_message_undoes_idx`. Last one is the "a batch is undone once, whatever races" guarantee (009_undo.sql).
- CHECK constraints (`*_one_ending`, `*_pair`) assert the state machine. They are cheap and are the right place for it.
- Missing in the DB: the `movement` live predicate. "Live" is `superseded_by IS NULL AND deleted_at IS NULL`, repeated as a string constant in three modules (src/ledger.ts:31, src/facts.ts:27, src/reminders/db.ts LIVE). The DB can own it as a view or a generated column.
- No exclusion constraints and no FKs to a shared effect table.

5. Append-only and versioned rows (superseded_by, restores)
- PG has no built-in feature. It is a pattern: SQL:2011 temporal tables (not in PG core) or a history table plus trigger. Alternatives: https://wiki.postgresql.org/wiki/Temporal_Extensions and the `temporal_tables` and `periods` extensions.
- PG 18 adds temporal PRIMARY KEY/UNIQUE with `WITHOUT OVERLAPS` and temporal foreign keys, via range types plus GiST. https://www.postgresql.org/docs/18/ddl-constraints.html. It fits validity ranges, not "restores" lineage.
- App must write: supersede, restore, follow-the-chain and "as the batch left it" checks. Today this is `supersede`/`softDelete` (src/ledger.ts:~100-123, 288-313), the recursive CTE `followForward` (:261-280), the loop in `headOf` (src/undo-reminders.ts:31-45, up to 20 queries) and `planFactUndo` in facts.
- Recursive CTE: https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-RECURSIVE. Note `hop < 50` is a hand-written cycle guard. PG 14+ has `CYCLE` clause (documented in the same page).
- An effect log with a single shape `(batch_id, entity_type, entity_id, op, before jsonb, after jsonb)` replaces three sets of chain code. It costs per-entity typed columns and FKs.

6. JSONB
- PG: https://www.postgresql.org/docs/current/datatype-json.html. Use `jsonb`, index with GIN, and `||` merges. CHECK constraints can test shape (`jsonb_typeof`).
- postgres.js: `sql.json(value)` serializes and types the parameter. The README documents the pattern. A plain object without `sql.json` is not what you want.
- Repo: `sql.json(x as never)` appears on every call site (src/store.ts:124, 327; src/ledger.ts:170-171; src/reminders/db.ts:118). The `as never` is a type workaround for `JSONValue` (types/index.d.ts:574-583) that the app should wrap once.
- `command`, `tool_calls`, `parsed`, `pending`, `timings` and `payload` have no shape constraints. They are free-form and written by code only. A stored `schedule` jsonb for reminders is validated in app code only.
- `COALESCE(timings,'{}') || …` at src/store.ts:329 is a correct use of jsonb merge.

7. Enums versus text
- PG: enum types (https://www.postgresql.org/docs/current/datatype-enum.html) are cheap to read and hard to change. `ALTER TYPE … ADD VALUE` works inside a transaction since PG 12 but the value cannot be used in that same transaction. Removal and renaming are painful. Text plus CHECK is the pattern the repo chose.
- Repo: text plus CHECK everywhere (`status`, `channel`, `kind`, `direction`, `currency`). Changing a CHECK means DROP/ADD CONSTRAINT, as 002_at_most_once.sql and 015_reminder_retry.sql did. At one-user scale that is fine, and it keeps migrations plain SQL.
- A lookup table with FK is the third option, and the only one that lets a new channel carry data (display name, window rules).

8. Triggers and audit tables
- PG: https://www.postgresql.org/docs/current/plpgsql-trigger.html. A trigger can enforce append-only (raise on UPDATE except for allowed columns) or write a history row.
- Repo: no triggers. Append-only is a discipline in code ("Nothing here updates a row's values"), but `UPDATE movement SET created_at = old.created_at` (src/ledger.ts:~117) does update values.
- A guard trigger or a REVOKE of UPDATE on non-pointer columns would turn the discipline into a guarantee. The cost is migration friction and that tests need to respect it.

9. Temporal patterns
- Repo: `created_at`, `deleted_at`, `received_at`, `meta_ts` and `occurred_on date` (user-facing business date). `timestamptz` is used consistently. Undo's 24 h window is computed in SQL from `received_at` (lastBatch, src/ledger.ts ~187-190, `ageSecs`) and compared in app code (src/undo.ts:~90).
- `now()` is the transaction start time, not the wall time. Inside long agent turns, use `clock_timestamp()` only if you need it. Today the reply commit happens in a short transaction after the model call, so this is not a bug.
- Reminder time zone: `next_due_at timestamptz` computed in app code. PG can do `AT TIME ZONE` and intervals, but calendar-recurrence rules ("any periodicity") are app logic. No built-in RRULE.

10. LISTEN/NOTIFY
- PG: https://www.postgresql.org/docs/current/sql-notify.html. Delivered at commit. Payload limit is 8000 bytes. It is not durable: a listener that is down misses messages, so it must be paired with a poll.
- postgres.js: `sql.listen(channel, fn, onListen)` (README line 1049). It holds a dedicated connection, reconnects, and calls `onListen` on every (re)connect, which is the hook to re-poll after a gap.
- Repo: unused. Work is picked up by a 30 s `setInterval` tick (src/server.ts:85) and by direct calls from the webhook path. Single replica and "first signal under 1 s" mean NOTIFY does not buy anything today. With a second channel worker or process, `NOTIFY turn_ready` plus the SKIP LOCKED claim is the documented wake-up. Not needed now.
- Note: NOTIFY through a transaction-pooling proxy (pgbouncer) breaks. Railway Postgres connects directly, so this is fine for now.

11. postgres.js specifics
- Transactions: `sql.begin` gives a scoped `tx`. In 4.x, a nested `sql.begin(fn)` inside a transaction runs in a savepoint (README line 844). `sql.savepoint(name, fn)` is explicit. A mode on a nested begin throws `NESTED_TRANSACTION_MODE`. So code can accept `sql` or `tx` and open "its own transaction" in both cases. The repo does not use savepoints; `Sql` is passed as a plain parameter.
- Types: `sql.begin` callback gets a `TransactionSql`, which the repo casts with `tx as unknown as Sql` (src/store.ts:~280, 385, src/mcp/write.ts:122, src/mcp/tools.ts:~499). Define `type Db = Sql | TransactionSql` once and drop the casts.
- Result typing: `sql<Row[]>` is an unchecked assertion. Rows are not validated. The README itself says to check array length (line ~1960).
- bigint: `int8` comes back as a string by default. The repo works around it with `::int` casts (40 occurrences in non-test source) and `Number(...)` (src/store.ts:183, 190, 194). The documented fix is `types: { bigint: postgres.BigInt }` or custom type parsers (README "Custom Types", line 1524), or declaring ids `integer`. Ids will not exceed 2^53 here.
- Arrays: `${ids}::bigint[]` with `= ANY(...)` is the documented pattern, and it works (src/ledger.ts:96). The README's `sql(array)` helper is for `IN`.
- Dynamic SQL: `sql.unsafe(LIVE)` fragments are used as trusted string constants. The documented, safe way is composing `sql` fragments, such as `sql\`...\`` or `sql.unsafe` only for identifiers and constants. The `folded(...)` and `GROUP_SQL` helpers (src/ledger.ts:145, 441) build strings the same way. They are constants today, so there is no injection risk, but they bypass typing.
- `sql.unsafe(file)` for migrations (src/db.ts:31) is the documented way to run a multi-statement string. `sql.file()` also exists.
- `reserve()`: a dedicated connection that is not in a transaction (README line 1641). Not used. Needed only for session-level state (session advisory locks, `SET`), which the repo avoids by design.
- Pooling: default `max` is 10. `connect()` sets none for the server, and `max: 1` for the CLI scripts (src/latency.ts:16, src/reminders/cli.ts:81). A held transaction takes one connection for its duration. The agent loop must never run an LLM call inside `sql.begin`. The commit transaction takes its model output as input, which matches this rule.
- `queue_timeout`, `query_timeout`, `statement_timeout`: README lines 673-675. Not configured. A stuck lock can hang a request until Meta's webhook gives up.
- `prepare` is off by default in 4.x (README line 720). With the dynamic SQL strings here, that is the right default.
- `sql.subscribe` (logical replication) needs `wal_level=logical` and a publication, which Railway may not permit. Skip it.

What the app must write whatever the schema
- Undo window and "once only" (the `undoes` unique index is the DB half).
- Cross-channel authorization (the account match).
- Idempotency of MCP requests (the unique `wamid`, which is the DB half, with `ON CONFLICT DO NOTHING`).
- At-most-once sends: the marker committed before send (src/store.ts ~299-310, the interim marker; `reply_text`/`reply_sent_at`). No database feature does this. It is a protocol.
- Lease expiry and attempts.

Where our code duplicates or works around Postgres/postgres.js (file:line, from this checkout)
1. The "live row" predicate is a string constant in three places: src/ledger.ts:31, src/facts.ts:27, src/reminders/db.ts (`LIVE`). Each is spliced with `sql.unsafe`. A view per table or a generated `live boolean` column would remove all three, plus every `sql.unsafe(LIVE)` call (about 20).
2. The supersede/restore/chain code exists three times. Movements: src/ledger.ts:261-280 (a recursive CTE) and :288-313. Facts: src/facts.ts:110-130, 195, 200-213. Reminders: src/undo-reminders.ts:31-45 (a 20-query loop, not a CTE) and :96. All walk `superseded_by`/`restores` links, each with its own `LIMIT` guard.
3. `lastBatch` (src/ledger.ts:~187-210) is a four-way `EXISTS` over movement, fact and reminder, with the "net of nothing" logic written into SQL. One effect log with `batch_id` would turn this into `SELECT … FROM effect WHERE batch_id`.
4. Five advisory-lock namespaces for what is one concept, "one writer per account": src/undo.ts:86, src/facts.ts:70, src/reminders/db.ts:58, src/auth/link.ts:65, src/db.ts:25. src/db.ts:19-20 lists four and omits 7203005. Undo takes 7203002 and then 7203005 (src/undo.ts:86, then `lockReminders`), a lock order every other path must also follow. A lock on the `account` row replaces them with one, and the order is then trivially safe.
5. `inbound_message` columns by role, one table four jobs: message log (`wamid`, `body`, `payload`), work queue (`status`, `attempts`, `claimed_at`, SKIP LOCKED at src/store.ts:166-180), batch (`action`, `reply_text`, `undoes`), pending question (`pending`, `asked_ids`, `asked_numbers`). MCP rows fake the first role with `payload '{}'`, `kind 'tool'`, a synthetic wamid (src/mcp/write.ts:122-126) and `status 'done'`. The whatsapp-only filter `WHERE channel = 'whatsapp'` is repeated in the claim queries (src/store.ts:~158-175) to keep MCP rows out of the queue.
6. Lock-then-check done by hand: `lockLive` (src/ledger.ts:80-89), the `lockRows` call (src/undo.ts, with `FOR UPDATE` at src/ledger.ts:241) and src/reminders/db.ts:79, 163, 174. With the account-row lock these checks stay, but the lock ordering concern goes away.
7. Type casts around `Sql`/`TransactionSql`: `as unknown as Sql` (src/store.ts, src/mcp/write.ts:122, src/mcp/tools.ts:~499, src/ledger.ts). A shared `Db` union type removes them.
8. `sql.json(x as never)` at src/store.ts:124, 327; src/ledger.ts:170-171; src/reminders/db.ts:118. One helper `json(v)` fixes the type once.
9. bigint-to-number: 40 `::int` casts plus `Number()` at src/store.ts:183, 190, 194, where the postgres.js `types` option (README:1524) handles it once.
10. Append-only is not enforced by the DB: `UPDATE movement SET created_at = old.created_at` (src/ledger.ts, in `supersede`) and the pointer updates are allowed, and nothing prevents an edit to `amount`. A trigger is the PG-provided guard.
11. Cycle guards written by hand: `hop < 50` (src/ledger.ts:~268) and `hop < 20` (src/undo-reminders.ts:34). The recursive-CTE `CYCLE` clause (PG 14+) exists, though acyclic data makes the guard a safety net.
12. `account` upsert as read-then-insert-then-`ON CONFLICT DO UPDATE SET wa_id = EXCLUDED.wa_id` (src/store.ts:187-194), a no-op update trick to get RETURNING. `INSERT … ON CONFLICT DO NOTHING RETURNING` plus a fallback select, or a CTE, is the documented alternative. Tiny.
13. Polling every 30 s (src/server.ts:85) where LISTEN/NOTIFY would give prompt wake-up. Low priority; not an issue at one replica.

Evidence for the question. The choices already lean on Postgres well: partial unique indexes, SKIP LOCKED, CHECK pairs, a recursive CTE. What the duplicated code is working around is the absence of one effect log and one lock. A neutral turn/batch table plus an effect log would delete items 2, 3, 4 and 5 and shrink 1 and 6. It would cost typed per-entity columns and FKs, and the live DB is small enough that a data migration is cheap. This is an observation from the code, not a measurement.