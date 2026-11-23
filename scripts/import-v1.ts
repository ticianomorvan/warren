/**
 * Reads a v1 database (tag `v1-final`) and writes the new schema. A one-time tool, deleted after the live check
 * (docs/design.md, "Ops").
 *
 *   V1_DATABASE_URL=<v1 url> DATABASE_URL=<new url> tsx scripts/import-v1.ts [--verify-only] [--days 30]
 *
 * The URLs come through the environment, never the command line, so no password shows in `ps` or in the shell history.
 *
 * What comes across, per account:
 * - the account and its WhatsApp address, with its `mcp_revoked_at`;
 * - the live movements, facts and reminders (a movement that was corrected or deleted, a fact that was replaced or
 *   forgotten and a cancelled reminder are history and stay behind in the old database, which the rollback keeps), each
 *   as a single live version made in one `import` turn;
 * - the `reminder_send` rows of the live reminders, so an occurrence that was sent is not sent again;
 * - the auth tables whole (users, sessions, OAuth clients, consents, tokens, signing keys), so a connected Claude keeps working;
 * - the WhatsApp messages of the last `--days` days (identity and state only: no text, no payload), so a retried webhook
 *   after the cutover is still a duplicate.
 *
 * Batches older than the cutover cannot be undone: the import turn is stored as an undo of an empty anchor turn, which the
 * undo engine never offers (`lastTurn` skips a turn that is an undo and a turn that did nothing).
 *
 * The old database is read inside one `REPEATABLE READ READ ONLY` transaction, so what comes across is one consistent
 * moment, and its `snapshot` (per table: row count, highest id, newest row version) is taken in that transaction.
 * `changedSince` compares a fresh read with it: the cutover calls it just before it switches, and aborts if anything changed.
 *
 * `verify` compares the two databases and never prints a description, an amount of one movement or an address: only counts
 * and sums. The CLI exits non-zero on any mismatch.
 */
import { fileURLToPath } from 'node:url'
import type { TransactionSql } from 'postgres'
import { connect, type Sql } from '../src/core/db'

export interface Check {
  name: string
  from: string
  to: string
}
export interface Summary {
  accounts: number
  movements: number
  facts: number
  reminders: number
  waMessages: number
}
/** Per table of the old database: `count|max id|newest row version (xmin)`. Anything written after the import read shows. */
export type Snapshot = Record<string, string>

/** Every table of the database: its row count, highest id and newest row version, xmin (never a value). */
export async function snapshotOf(db: Sql | TransactionSql): Promise<Snapshot> {
  const tables = await db<{ t: string; has_id: boolean }[]>`
    SELECT t.table_name AS t,
           EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'id' AND c.data_type IN ('smallint', 'integer', 'bigint')) AS has_id
    FROM information_schema.tables t
    WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE' ORDER BY 1`
  const out: Snapshot = {}
  for (const { t, has_id } of tables) {
    const [r] = await db.unsafe<{ n: string; m: string | null; x: string | null }[]>(
      `SELECT count(*)::text AS n, ${has_id ? 'max(id)::text' : 'NULL'} AS m, max(xmin::text::bigint)::text AS x FROM "${t}"`,
    )
    out[t] = `${r?.n}|${r?.m ?? '-'}|${r?.x ?? '-'}`
  }
  return out
}

/** The tables whose snapshot differs from `before` now. */
export async function changedSince(db: Sql, before: Snapshot): Promise<string[]> {
  const now = await snapshotOf(db)
  return [...new Set([...Object.keys(before), ...Object.keys(now)])]
    .filter((t) => before[t] !== now[t])
    .sort()
}

/** The auth tables, in the order their foreign keys allow. Copied row for row (the columns both schemas have). */
const AUTH_TABLES = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'auth_jwks',
  'auth_oauth_client',
  'auth_oauth_resource',
  'auth_oauth_client_resource',
  'auth_oauth_consent',
  'auth_oauth_access_token',
  'auth_oauth_refresh_token',
  'auth_oauth_client_assertion',
  'link_request',
] as const

const LIVE = {
  movement: 'superseded_by IS NULL AND deleted_at IS NULL',
  fact: 'superseded_by IS NULL AND forgotten_at IS NULL',
  reminder: 'cancelled_at IS NULL',
} as const

/** Copies a table's rows between two databases, over the columns both have, typed as the target says. */
async function copyTable(
  from: Sql | TransactionSql,
  tx: Sql | TransactionSql,
  table: string,
): Promise<number> {
  const cols = async (db: Sql | TransactionSql) =>
    (
      await db<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${table} ORDER BY ordinal_position`
    ).map((c) => c)
  const source = new Set((await cols(from)).map((c) => c.column_name))
  const target = await cols(tx)
  if (target.length === 0) throw new Error(`the new schema has no table ${table}`)
  const shared = target.filter((c) => source.has(c.column_name))
  const rows = await from.unsafe<Record<string, unknown>[]>(
    `SELECT ${shared.map((c) => `"${c.column_name}"`).join(', ')} FROM "${table}"`,
  )
  for (const row of rows) {
    const values = shared.map((c) => {
      const v = row[c.column_name]
      return v !== null &&
        typeof v === 'object' &&
        !(v instanceof Date) &&
        c.data_type.startsWith('json')
        ? tx.json(v as never)
        : v
    })
    await tx.unsafe(
      `INSERT INTO "${table}" (${shared.map((c) => `"${c.column_name}"`).join(', ')}) VALUES (${shared.map((_, i) => `$${i + 1}`).join(', ')})`,
      values as never[],
    )
  }
  // Sequences carry on from the copied rows: the next sign-in (link_request) must not reuse an id.
  const serial = await tx<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}
      AND pg_get_serial_sequence(${table}, column_name) IS NOT NULL`
  for (const { column_name: c } of serial)
    await tx.unsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', '${c}'), coalesce(max("${c}"), 1), max("${c}") IS NOT NULL) FROM "${table}"`,
    )
  return rows.length
}

export async function importV1(
  source: Sql,
  to: Sql,
  o: { now?: Date; days?: number } = {},
): Promise<Summary & { snapshot: Snapshot }> {
  const now = o.now ?? new Date()
  const days = o.days ?? 30
  const summary: Summary = { accounts: 0, movements: 0, facts: 0, reminders: 0, waMessages: 0 }
  let snapshot: Snapshot = {}

  // One consistent, read-only moment of the old database; the new one is written in its own transaction.
  await source.begin('isolation level repeatable read read only', async (from) => {
    snapshot = await snapshotOf(from)
    await copyAll(from, to)
  })
  return { ...summary, snapshot }

  async function copyAll(from: TransactionSql, to: Sql) {
    await to.begin(async (tx) => {
      const [existing] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM account`
      if (existing && existing.n !== '0')
        throw new Error('the target database already has accounts: refusing to import')

      // Accounts and addresses, with their ids (the auth users point at them).
      const accounts = await from<
        { id: string; wa_id: string; created_at: Date; mcp_revoked_at: Date | null }[]
      >`
      SELECT id::text, wa_id, created_at, mcp_revoked_at FROM account ORDER BY id`
      for (const a of accounts) {
        await tx`INSERT INTO account (id, created_at, mcp_revoked_at) VALUES (${a.id}, ${a.created_at}, ${a.mcp_revoked_at})`
        await tx`INSERT INTO account_address (account_id, channel, address, created_at) VALUES (${a.id}, 'whatsapp', ${a.wa_id}, ${a.created_at})`
      }
      await tx`SELECT setval(pg_get_serial_sequence('account', 'id'), GREATEST((SELECT max(id) FROM account), 1))`
      summary.accounts = accounts.length

      for (const a of accounts) {
        const movements = await from<Record<string, unknown>[]>`
        SELECT direction, amount::text AS amount, currency, occurred_on::text AS occurred_on, description, category, payment,
               confidence, created_at
        FROM movement WHERE account_id = ${a.id} AND superseded_by IS NULL AND deleted_at IS NULL ORDER BY id`
        const facts = await from<Record<string, unknown>[]>`
        SELECT kind, key, value, created_at FROM fact
        WHERE account_id = ${a.id} AND superseded_by IS NULL AND forgotten_at IS NULL ORDER BY id`
        const reminders = await from<
          {
            id: string
            what: string
            schedule: unknown
            next_due_at: Date | null
            created_at: Date
          }[]
        >`
        SELECT id::text, what, schedule, next_due_at, created_at FROM reminder
        WHERE account_id = ${a.id} AND cancelled_at IS NULL ORDER BY id`
        if (movements.length + facts.length + reminders.length === 0) continue

        const [anchor] = await tx<{ id: string }[]>`
        INSERT INTO turn (account_id, channel, created_at, label, reply)
        VALUES (${a.id}, 'cli', ${now}, 'import', 'anchor of the v1 import: nothing to undo before it') RETURNING id::text`
        const [turn] = await tx<{ id: string }[]>`
        INSERT INTO turn (account_id, channel, created_at, label, reply, undoes)
        VALUES (${a.id}, 'cli', ${now}, 'import', 'imported from v1', ${anchor?.id ?? null}) RETURNING id::text`
        const madeIn = turn?.id ?? ''

        for (const m of movements) {
          await tx`
          INSERT INTO movement (account_id, made_in, logged_at, direction, amount, currency, occurred_on, description, category, payment, confidence)
          VALUES (${a.id}, ${madeIn}, ${m.created_at as Date}, ${m.direction as string}, ${m.amount as string}, ${m.currency as string},
                  ${m.occurred_on as string}, ${m.description as string}, ${m.category as string}, ${(m.payment as string | null) ?? null}, ${m.confidence as string})`
        }
        for (const f of facts) {
          await tx`
          INSERT INTO fact (account_id, made_in, logged_at, kind, key, value)
          VALUES (${a.id}, ${madeIn}, ${f.created_at as Date}, ${f.kind as string}, ${f.key as string}, ${f.value as string})`
        }
        for (const r of reminders) {
          const [made] = await tx<{ entity_id: string }[]>`
          INSERT INTO reminder (account_id, made_in, logged_at, what, schedule, next_due_at)
          VALUES (${a.id}, ${madeIn}, ${r.created_at}, ${r.what}, ${tx.json(r.schedule as never)}, ${r.next_due_at})
          RETURNING entity_id::text`
          // An occurrence already sent stays sent: the unique key (reminder, due_at) is the at-most-once guard.
          const sends = await from<Record<string, unknown>[]>`
          SELECT due_at, kind, started_at, wamid, status, error_code FROM reminder_send WHERE reminder_id = ${r.id}`
          for (const s of sends) {
            await tx`
            INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, wamid, status, error_code)
            VALUES (${a.id}, ${made?.entity_id ?? ''}, ${s.due_at as Date}, ${s.kind as string}, ${s.started_at as Date},
                    ${(s.wamid as string | null) ?? null}, ${s.status as string}, ${(s.error_code as number | null) ?? null})`
          }
        }
        summary.movements += movements.length
        summary.facts += facts.length
        summary.reminders += reminders.length
      }

      for (const table of AUTH_TABLES) await copyTable(from, tx, table)

      // Recent WhatsApp messages: identity and state, so a retried webhook is still a duplicate. A message that was still open at
      // the cutover is marked failed (the person will write again); no text and no media id come across.
      const since = new Date(now.getTime() - days * 86_400_000)
      const messages = await from<Record<string, unknown>[]>`
      SELECT wamid, wa_id, kind, status, attempts, meta_ts, received_at, claimed_at, typing_sent_at, send_started_at, reply_sent_at, error
      FROM inbound_message WHERE channel = 'whatsapp' AND received_at >= ${since} ORDER BY id`
      for (const m of messages) {
        const open = m.status === 'pending' || m.status === 'processing'
        await tx`
        INSERT INTO wa_message (wamid, wa_id, kind, status, attempts, meta_ts, received_at, claimed_at, typing_sent_at, send_started_at, reply_sent_at, error)
        VALUES (${m.wamid as string}, ${m.wa_id as string}, ${m.kind as string}, ${open ? 'failed' : (m.status as string)}, ${m.attempts as number},
                ${m.meta_ts as Date | null}, ${m.received_at as Date}, ${m.claimed_at as Date | null}, ${m.typing_sent_at as Date | null},
                ${m.send_started_at as Date | null}, ${m.reply_sent_at as Date | null}, ${open ? 'open at the v1 cutover' : ((m.error as string | null) ?? null)})`
      }
      summary.waMessages = messages.length
    })
  }
}

const j = (v: unknown) => JSON.stringify(v)

export async function verifyV1(
  from: Sql,
  to: Sql,
  o: { now?: Date; days?: number } = {},
): Promise<Check[]> {
  const now = o.now ?? new Date()
  const since = new Date(now.getTime() - (o.days ?? 30) * 86_400_000)
  const checks: Check[] = []
  const add = (name: string, a: unknown, b: unknown) => checks.push({ name, from: j(a), to: j(b) })

  add(
    'accounts: ids, a fingerprint of their addresses, and which cut their MCP connections',
    await from`SELECT count(*)::text AS n, md5(string_agg(id || '|' || wa_id || '|' || (mcp_revoked_at IS NOT NULL), ';' ORDER BY id)) AS fp FROM account`,
    await to`SELECT count(*)::text AS n, md5(string_agg(a.id || '|' || ad.address || '|' || (a.mcp_revoked_at IS NOT NULL), ';' ORDER BY a.id)) AS fp
             FROM account a JOIN account_address ad ON ad.account_id = a.id AND ad.channel = 'whatsapp'`,
  )
  add(
    'live movements: count and sum per account and currency',
    await from`SELECT account_id::text, currency, count(*)::text AS n, sum(amount)::text AS total FROM movement
               WHERE ${from.unsafe(LIVE.movement)} GROUP BY 1, 2 ORDER BY 1, 2`,
    await to`SELECT account_id::text, currency, count(*)::text AS n, sum(amount)::text AS total FROM movement
             WHERE ended_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2`,
  )
  add(
    'live movements: total count',
    await from`SELECT count(*)::text AS n FROM movement WHERE ${from.unsafe(LIVE.movement)}`,
    await to`SELECT count(*)::text AS n FROM movement WHERE ended_at IS NULL`,
  )
  // What each movement says, not only how many and how much: one md5 per account over the rows' text, in a fixed order.
  const moveText = `direction || '|' || amount::text || '|' || currency || '|' || occurred_on::text || '|' || description || '|' || category || '|' || coalesce(payment, '') || '|' || confidence`
  add(
    'live movements: a fingerprint of what each one says, per account',
    await from.unsafe(
      `SELECT account_id::text, md5(string_agg(${moveText}, ';' ORDER BY ${moveText} COLLATE "C")) AS fp FROM movement WHERE ${LIVE.movement} GROUP BY 1 ORDER BY 1`,
    ),
    await to.unsafe(
      `SELECT account_id::text, md5(string_agg(${moveText}, ';' ORDER BY ${moveText} COLLATE "C")) AS fp FROM movement WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`,
    ),
  )
  const remindText = `what || '|' || schedule::jsonb::text || '|' || coalesce(extract(epoch FROM next_due_at)::text, '-')`
  add(
    'live reminders: a fingerprint of what, schedule and next due time, per account',
    await from.unsafe(
      `SELECT account_id::text, md5(string_agg(${remindText}, ';' ORDER BY ${remindText} COLLATE "C")) AS fp FROM reminder WHERE ${LIVE.reminder} GROUP BY 1 ORDER BY 1`,
    ),
    await to.unsafe(
      `SELECT account_id::text, md5(string_agg(${remindText}, ';' ORDER BY ${remindText} COLLATE "C")) AS fp FROM reminder WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`,
    ),
  )
  add(
    'live facts: count per account and a fingerprint of kind, key and value',
    await from`SELECT account_id::text, count(*)::text AS n, md5(string_agg(kind || '|' || key || '|' || value, ';' ORDER BY kind, key)) AS fp
               FROM fact WHERE ${from.unsafe(LIVE.fact)} GROUP BY 1 ORDER BY 1`,
    await to`SELECT account_id::text, count(*)::text AS n, md5(string_agg(kind || '|' || key || '|' || value, ';' ORDER BY kind, key)) AS fp
             FROM fact WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`,
  )
  add(
    'live reminders: count per account, how many have next_due_at, and a fingerprint of their due times',
    await from`SELECT account_id::text, count(*)::text AS n, count(next_due_at)::text AS due,
                      md5(string_agg(coalesce(extract(epoch FROM next_due_at)::text, '-') || '|' || what, ';' ORDER BY what, next_due_at)) AS fp
               FROM reminder WHERE ${from.unsafe(LIVE.reminder)} GROUP BY 1 ORDER BY 1`,
    await to`SELECT account_id::text, count(*)::text AS n, count(next_due_at)::text AS due,
                    md5(string_agg(coalesce(extract(epoch FROM next_due_at)::text, '-') || '|' || what, ';' ORDER BY what, next_due_at)) AS fp
             FROM reminder WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`,
  )
  add(
    'reminder sends of live reminders',
    await from`SELECT count(*)::text AS n FROM reminder_send s JOIN reminder r ON r.id = s.reminder_id WHERE ${from.unsafe(LIVE.reminder.replaceAll('cancelled_at', 'r.cancelled_at'))}`,
    await to`SELECT count(*)::text AS n FROM reminder_send`,
  )
  for (const t of [
    'auth_user',
    'auth_session',
    'auth_oauth_client',
    'auth_oauth_consent',
    'auth_oauth_access_token',
    'auth_oauth_refresh_token',
    'auth_jwks',
  ] as const) {
    add(
      `${t}: count`,
      await from.unsafe(`SELECT count(*)::text AS n FROM ${t}`),
      await to.unsafe(`SELECT count(*)::text AS n FROM ${t}`),
    )
  }
  add(
    'auth users linked to an account',
    await from`SELECT count(*)::text AS n FROM auth_user WHERE warren_account_id IS NOT NULL`,
    await to`SELECT count(*)::text AS n FROM auth_user u JOIN account a ON a.id = u.warren_account_id`,
  )
  add(
    'recent wamids (dedupe)',
    await from`SELECT count(*)::text AS n, md5(string_agg(wamid, ';' ORDER BY wamid)) AS fp FROM inbound_message WHERE channel = 'whatsapp' AND received_at >= ${since}`,
    await to`SELECT count(*)::text AS n, md5(string_agg(wamid, ';' ORDER BY wamid)) AS fp FROM wa_message WHERE received_at >= ${since}`,
  )
  return checks
}

export const mismatches = (checks: Check[]) => checks.filter((c) => c.from !== c.to)

// ---------------------------------------------------------------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const fromUrl = process.env.V1_DATABASE_URL
  const toUrl = process.env.DATABASE_URL
  const days = arg('days') ? Number(arg('days')) : undefined
  if (!fromUrl || !toUrl) {
    console.error(
      'usage: V1_DATABASE_URL=<v1 url> DATABASE_URL=<new url> tsx scripts/import-v1.ts [--verify-only] [--days 30]',
    )
    process.exit(2)
  }
  const from = connect(fromUrl, { max: 1 })
  const to = connect(toUrl, { max: 1 })
  try {
    if (!process.argv.includes('--verify-only')) {
      const s = await importV1(from, to, { days })
      console.log(
        `imported: ${s.accounts} accounts, ${s.movements} movements, ${s.facts} facts, ${s.reminders} reminders, ${s.waMessages} wa messages`,
      )
    }
    const checks = await verifyV1(from, to, { days })
    for (const c of checks)
      console.log(
        `${c.from === c.to ? 'ok  ' : 'FAIL'} ${c.name}${c.from === c.to ? '' : `\n     v1: ${c.from}\n     new: ${c.to}`}`,
      )
    const bad = mismatches(checks)
    console.log(
      bad.length
        ? `verify FAILED: ${bad.length} of ${checks.length} checks differ`
        : `verify passed: ${checks.length} checks`,
    )
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await from.end({ timeout: 2 })
    await to.end({ timeout: 2 })
  }
}
