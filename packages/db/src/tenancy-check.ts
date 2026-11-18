import { randomUUID } from 'node:crypto'
import type { BankOperation } from '@warren/core'
import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm'
import { asUser, type Database, inSystemContext, inUserContext, rowsOf } from './client'
import { createLedger, seedAccounts } from './ledger'
import { createMailLog } from './mail-log'
import { createOutbox } from './outbox'
import { erasure, user } from './schema'
import * as system from './system'
import {
  AUTH_TABLES as AUTH,
  ERASED_TABLES,
  EXEMPT_TABLES as EXEMPT,
  KEPT_TABLES,
  tableNames,
} from './tables'

/*
 * The proof that Postgres, not app code, keeps users apart. `pnpm test` runs it on an
 * in-process Postgres; `pnpm db:tenancy-check` runs the same code against a real branch
 * through the pooler, which is where the user context could leak. Each check returns what it
 * found instead of throwing, so a run lists every failure.
 */

export type Check = { name: string; ok: boolean; detail?: string }

/** Better Auth's tables and the one exempt table: tagged once, in tables.ts. */
export const AUTH_TABLES = tableNames(AUTH).slice() as readonly string[]
export const EXEMPT_TABLES = tableNames(EXEMPT).slice() as readonly string[]
/** Keys that do not start with `user_id`, on purpose. Each needs a reason. */
export const EXEMPT_KEYS: Record<string, string> = {
  // An address belongs to one person, and only the operator registers it.
  mailbox_address_unique: 'a mailbox address belongs to one person; operator-written',
}

type Row = Record<string, unknown>
const query = async <T extends Row>(db: Database, statement: ReturnType<typeof sql>) =>
  inSystemContext(db, async (tx) => rowsOf<T>(await tx.execute(statement)))

/** Tables in `public` that hold a user's rows: everything not exempt and not an auth table. */
async function tenantTables(db: Database): Promise<{ name: string; hasUserId: boolean }[]> {
  const rows = await query<{ name: string; has_user_id: boolean }>(
    db,
    sql`select c.relname as name,
               exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped)
                 as has_user_id
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
  )
  const set = new Set<string>([...AUTH_TABLES, ...EXEMPT_TABLES])
  return rows
    .filter((r) => !set.has(r.name))
    .map((r) => ({ name: r.name, hasUserId: r.has_user_id }))
}

/** What the catalog says: every table classified, row-level security, policies, keys, grants. */
export async function checkStructure(db: Database): Promise<Check[]> {
  const out: Check[] = []
  const tables = await tenantTables(db)
  const names = tables.map((t) => t.name)

  const missingUserId = tables.filter((t) => !t.hasUserId).map((t) => t.name)
  out.push({
    name: 'every table has user_id, or is on the exempt list',
    ok: missingUserId.length === 0,
    detail: missingUserId.join(', '),
  })

  const rls = await query<{ name: string; on: boolean }>(
    db,
    sql`select c.relname as name, c.relrowsecurity as on
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`,
  )
  const rlsOn = new Map(rls.map((r) => [r.name, r.on]))
  const noRls = names.filter((n) => !rlsOn.get(n))
  out.push({
    name: 'row-level security is on for every user table',
    ok: noRls.length === 0,
    detail: noRls.join(', '),
  })

  const policies = await query<{ table: string; cmd: string; roles: string }>(
    db,
    sql`select tablename as table, cmd, roles::text as roles
        from pg_policies where schemaname = 'public'`,
  )
  const has = (table: string, cmd: string) =>
    policies.some((p) => p.table === table && p.cmd === cmd && p.roles.includes('warren_app'))
  const lacking = names.flatMap((n) => [
    ...(has(n, 'SELECT') ? [] : [`${n}:select`]),
    ...(has(n, 'INSERT') ? [] : [`${n}:insert`]),
  ])
  if (names.includes('movement') && !has('movement', 'UPDATE')) lacking.push('movement:update')
  const extraUpdate = names.filter((n) => n !== 'movement' && has(n, 'UPDATE'))
  out.push({
    name: 'warren_app has select and insert policies on every user table, update only on movement',
    ok: lacking.length === 0 && extraUpdate.length === 0,
    detail: [
      ...lacking.map((l) => `missing ${l}`),
      ...extraUpdate.map((n) => `extra update on ${n}`),
    ].join(', '),
  })

  const keys = await query<{ table: string; name: string; first: string }>(
    db,
    sql`select c.relname as table, con.conname as name, a.attname as first
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
        where n.nspname = 'public' and con.contype in ('p', 'u', 'f')`,
  )
  const indexes = await query<{ table: string; name: string; first: string }>(
    db,
    sql`select c.relname as table, i.relname as name, a.attname as first
        from pg_index x
        join pg_class c on c.oid = x.indrelid
        join pg_class i on i.oid = x.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum = x.indkey[0]
        where n.nspname = 'public' and x.indisunique`,
  )
  const badKeys = [...keys, ...indexes]
    .filter((k) => names.includes(k.table) && k.first !== 'user_id' && !(k.name in EXEMPT_KEYS))
    .map((k) => `${k.table}.${k.name}`)
  out.push({
    name: 'every primary key, unique key and foreign key starts with user_id',
    ok: badKeys.length === 0,
    detail: [...new Set(badKeys)].join(', '),
  })

  const priv = await query<{ role: string; table: string; verb: string; yes: boolean }>(
    db,
    sql`select r.role, t.table, v.verb,
               has_table_privilege(r.role, format('public.%I', t.table), v.verb) as yes
        from (values ('warren_app'), ('warren_auth')) r(role)
        cross join (select relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind in ('r', 'p')) t
        cross join (values ('select'), ('insert'), ('update'), ('delete')) v(verb)`,
  )
  const auth = new Set<string>(AUTH_TABLES)
  const appOnAuth = priv.filter((p) => p.role === 'warren_app' && auth.has(p.table) && p.yes)
  const authOnData = priv.filter((p) => p.role === 'warren_auth' && !auth.has(p.table) && p.yes)
  const appMutates = priv.filter(
    (p) =>
      p.role === 'warren_app' &&
      p.yes &&
      ((p.verb === 'delete' && !auth.has(p.table)) ||
        (p.verb === 'update' && !auth.has(p.table) && p.table !== 'movement')),
  )
  out.push({
    name: 'grants: warren_app cannot touch auth tables or update/delete; warren_auth only auth tables',
    ok: appOnAuth.length + authOnData.length + appMutates.length === 0,
    detail: [...appOnAuth, ...authOnData, ...appMutates]
      .map((p) => `${p.role} ${p.verb} ${p.table}`)
      .join(', '),
  })
  return out
}

/**
 * Erasure covers everything. Reads the catalog and compares it with the tags in tables.ts:
 * every table is tagged; a kept table holds only sealed columns and reviewed clear ones; and
 * what `warren_eraser` can actually do (grants, policies, triggers) is exactly the erasure
 * set, no more and no less. The SQL cannot be derived from the tags, so this is what keeps
 * the two from drifting.
 */
export async function checkErasure(db: Database): Promise<Check[]> {
  const out: Check[] = []
  const erased = tableNames(ERASED_TABLES).sort()
  const kept = KEPT_TABLES.map((k) => getTableName(k.table)).sort()
  const tagged = new Set<string>([...tableNames(AUTH), ...tableNames(EXEMPT), ...erased, ...kept])

  const tables = await query<{ name: string }>(
    db,
    sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  )
  const untagged = tables.map((t) => t.name).filter((n) => !tagged.has(n))
  const missing = [...tagged].filter((n) => !tables.some((t) => t.name === n))
  out.push({
    name: 'every table is tagged once: auth, exempt, erased with the user, or kept',
    ok: untagged.length === 0 && missing.length === 0,
    detail: [
      ...untagged.map((n) => `${n} is in no list (tables.ts)`),
      ...missing.map((n) => `${n} is tagged but does not exist`),
    ].join(', '),
  })

  const columns = await query<{ table: string; column: string; type: string }>(
    db,
    sql`select table_name as table, column_name as column, data_type as type
        from information_schema.columns where table_schema = 'public'`,
  )
  const problems: string[] = []
  for (const k of KEPT_TABLES) {
    const name = getTableName(k.table)
    const all = getTableColumns(k.table)
    const dbName = (key: string) => all[key]?.name ?? `?${key}`
    const sealed = k.sealed.map((c) => dbName(String(c)))
    const clear = k.clear.map((c) => dbName(String(c)))
    const actual = columns.filter((c) => c.table === name)
    for (const c of actual) {
      if (!sealed.includes(c.column) && !clear.includes(c.column)) {
        problems.push(`${name}.${c.column} is neither sealed nor on the reviewed clear list`)
      }
    }
    for (const c of [...sealed, ...clear]) {
      if (!actual.some((a) => a.column === c)) problems.push(`${name}.${c} is listed but missing`)
    }
    for (const c of sealed) {
      if (actual.find((a) => a.column === c)?.type !== 'bytea') {
        problems.push(`${name}.${c} is listed as sealed but is not bytea`)
      }
    }
  }
  out.push({
    name: 'a table kept after erasure has only sealed columns and reviewed clear ones',
    ok: problems.length === 0,
    detail: problems.join(', '),
  })

  const tableGrants = await query<{ table: string; priv: string }>(
    db,
    sql`select c.relname as table, a.privilege_type as priv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace,
             aclexplode(c.relacl) a
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and a.grantee = (select oid from pg_roles where rolname = 'warren_eraser')`,
  )
  const columnGrants = await query<{ table: string; column: string; priv: string }>(
    db,
    sql`select c.relname as table, t.attname as column, a.privilege_type as priv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute t on t.attrelid = c.oid, aclexplode(t.attacl) a
        where n.nspname = 'public' and t.attacl is not null and not t.attisdropped
          and a.grantee = (select oid from pg_roles where rolname = 'warren_eraser')`,
  )
  const grants = [
    ...tableGrants.map((g) => `${g.table} ${g.priv}`),
    ...columnGrants.map((g) => `${g.table}.${g.column} ${g.priv}`),
  ].sort()
  const wantedGrants = [
    ...erased.flatMap((t) => [`${t} DELETE`, `${t}.user_id SELECT`]),
    // The tombstone, and the chain head it records.
    'erasure SELECT',
    'erasure INSERT',
    ...['user_id', 'seq', 'chain_sha256'].map((c) => `event.${c} SELECT`),
  ].sort()
  out.push({
    name: "warren_eraser's grants are exactly the erasure set, plus the tombstone and the chain head",
    ok: grants.join('|') === wantedGrants.join('|'),
    detail: [
      ...wantedGrants.filter((g) => !grants.includes(g)).map((g) => `missing: ${g}`),
      ...grants.filter((g) => !wantedGrants.includes(g)).map((g) => `extra: ${g}`),
    ].join(', '),
  })

  const policies = await query<{ table: string; cmd: string }>(
    db,
    sql`select tablename as table, cmd from pg_policies
        where schemaname = 'public' and roles::text like '%warren_eraser%'`,
  )
  const havePolicies = policies.map((p) => `${p.table} ${p.cmd}`).sort()
  const wantedPolicies = [
    ...erased.flatMap((t) => [`${t} DELETE`, `${t} SELECT`]),
    'erasure SELECT',
    'erasure INSERT',
    'event SELECT',
  ].sort()
  out.push({
    name: "warren_eraser's policies are exactly the erasure set, plus the tombstone and the chain head",
    ok: havePolicies.join('|') === wantedPolicies.join('|'),
    detail: [
      ...wantedPolicies.filter((g) => !havePolicies.includes(g)).map((g) => `missing: ${g}`),
      ...havePolicies.filter((g) => !wantedPolicies.includes(g)).map((g) => `extra: ${g}`),
    ].join(', '),
  })

  // Append-only tables in the erasure set carry the delete-for-erasure exception; the others
  // (movement, mailbox, sources, key) are mutable and carry no trigger. A plain
  // `forbid_mutation` on an erased table would make erasure fail halfway, and the exception on
  // any other table would let the eraser delete append-only rows.
  const triggers = await query<{ table: string; fn: string }>(
    db,
    sql`select c.relname as table, p.proname as fn
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and t.tgtype & 1 = 1
          and p.proname in ('forbid_mutation', 'forbid_mutation_except_erasure')`,
  )
  const blocking = triggers.filter((t) => t.fn === 'forbid_mutation' && erased.includes(t.table))
  const stray = triggers.filter(
    (t) => t.fn === 'forbid_mutation_except_erasure' && !erased.includes(t.table),
  )
  out.push({
    name: 'the delete-for-erasure exception is only on erased tables, and nothing blocks erasing them',
    ok: blocking.length === 0 && stray.length === 0,
    detail: [
      ...blocking.map((t) => `${t.table} blocks every delete`),
      ...stray.map((t) => `${t.table} lets the eraser delete but is not in the erasure set`),
    ].join(', '),
  })
  return out
}

const sent: BankOperation = {
  kind: 'transfer_out',
  amount: '1500.00',
  currency: 'ARS',
  date: '2026-11-14',
  time: '14:09',
  ownAccount: 'CA-ARS ***123/4',
  counterparty: { name: 'Juana Ejemplo', account: '0170099220000012345670', taxId: '20123456786' },
  reference: '1017000001',
  reason: 'VARIOS',
}

/** Makes a user row, as the operator or Better Auth would. Returns its id. */
export async function createTestUser(owner: Database, label: string): Promise<string> {
  const rows = await inSystemContext(owner, (tx) =>
    tx
      .insert(user)
      .values({ name: label, email: `${label}-${randomUUID()}@example.invalid` })
      .returning({ id: user.id }),
  )
  const id = rows[0]?.id
  if (!id) throw new Error('user insert returned no row')
  return id
}

/**
 * Gives a user a row in every table, through the same code the app runs, plus the tables only
 * the operator writes. Invented identifiers only. A table left empty would make the isolation
 * check vacuous, so the check fails on it. `tombstone: false` skips the fake erasure row, for
 * a user who is going to be erased for real.
 */
export async function seedFixtures(
  owner: Database,
  app: Database,
  userId: string,
  tag: string,
  options: { tombstone?: boolean } = {},
): Promise<void> {
  await asUser(owner, userId, (scope) =>
    seedAccounts(scope, [
      {
        id: 'asset:bank:ars',
        kind: 'asset',
        name: `Bank ${tag}`,
        currency: 'ARS',
        institution: 'Bank',
        identifiers: [{ scheme: 'bank-label', value: 'CA-ARS ***123/4' }],
      },
    ]),
  )
  await system.addMailbox(owner, userId, `${tag}-${userId.slice(0, 8)}@example.invalid`)
  if (options.tombstone !== false) {
    await inSystemContext(owner, (tx) => tx.insert(erasure).values({ userId, chainHead: null }))
  }

  await asUser(app, userId, async (scope) => {
    const log = createMailLog(scope)
    const mailId = scope.mailId(Buffer.from(`mail ${tag}`))
    await log.recordMail({
      mailId,
      pathname: `u/${userId}/mail/${mailId}.eml.sealed`,
      bytes: 10,
      provider: 'check',
      providerId: `check-${tag}`,
      receivedAt: new Date('2026-11-14T17:10:00Z'),
    })
    await log.recordVerdict(
      mailId,
      {
        verdict: 'verified',
        senderId: 'bbva-transfers',
        fromAddress: 'avisos@bbva.com.ar',
        signingDomain: 'bbva.com.ar',
        selector: 's1',
        keyRecord: 'v=DKIM1',
        signedHeaders: ['from', 'to', 'date', 'subject'],
        subject: 'Realizaste una transferencia',
        signedDate: new Date('2026-11-14T17:09:00Z'),
      },
      1,
    )
    await log.recordParse(mailId, 1, {
      status: 'parsed',
      templateId: 'bbva.transfer-sent',
      templateVersion: 1,
      operation: sent,
    })
    await createLedger(scope).recordMailOperation({
      mailId,
      templateId: 'bbva.transfer-sent',
      operation: sent,
    })
    const outbox = createOutbox(scope)
    await outbox.drain(async () => ({
      mode: 'text',
      body: 'hola',
      outcome: 'sent',
      wamid: `wamid.${tag}`,
    }))
    await outbox.recordStatus({
      wamid: `wamid.${tag}`,
      status: 'delivered',
      errorCode: null,
      occurredAt: new Date('2026-11-14T17:11:00Z'),
    })
  })
}

type Tx = Parameters<Parameters<typeof inSystemContext>[1]>[0]
const scalar = async (tx: Tx, statement: ReturnType<typeof sql>) =>
  rowsOf<{ n: number }>(await tx.execute(statement))[0]?.n ?? -1

const count = async (db: Database, userId: string | null, table: string) => {
  const run = (tx: Tx) => scalar(tx, sql`select count(*)::int as n from ${sql.identifier(table)}`)
  return userId ? inUserContext(db, userId, run) : inSystemContext(db, run)
}

const refused = /row-level security|permission denied/

export type Isolation = { owner: Database; app: Database; a: string; b: string }

/**
 * As `warren_app`, user A reads exactly A's rows and none of B's, on every table, and the
 * other way round; with no user it reads nothing; and it cannot write another user's row.
 * Row counts come from the owner, who sees everything.
 */
export async function checkIsolation({ owner, app, a, b }: Isolation): Promise<Check[]> {
  const out: Check[] = []
  const tables = (await tenantTables(owner)).map((t) => t.name)
  const countFor = (userId: string, table: string) =>
    inSystemContext(owner, (tx) =>
      scalar(
        tx,
        sql`select count(*)::int as n from ${sql.identifier(table)} where user_id = ${userId}::uuid`,
      ),
    )

  const problems: string[] = []
  for (const table of tables) {
    const [ownerA, ownerB] = [await countFor(a, table), await countFor(b, table)]
    if (ownerA < 1 || ownerB < 1) {
      problems.push(`${table}: no fixture rows for both users, so nothing was proven`)
      continue
    }
    const [asA, asB] = [await count(app, a, table), await count(app, b, table)]
    if (asA !== ownerA) problems.push(`${table}: as A saw ${asA} rows, A has ${ownerA}`)
    if (asB !== ownerB) problems.push(`${table}: as B saw ${asB} rows, B has ${ownerB}`)
    const leaked = await inUserContext(app, a, (tx) =>
      scalar(
        tx,
        sql`select count(*)::int as n from ${sql.identifier(table)} where user_id = ${b}::uuid`,
      ),
    )
    if (leaked !== 0) problems.push(`${table}: A can see ${leaked} of B's rows`)
  }
  out.push({
    name: `as warren_app, each user reads only their own rows (${tables.length} tables)`,
    ok: problems.length === 0,
    detail: problems.join('; '),
  })

  const noContext: string[] = []
  for (const table of tables) {
    const n = await count(app, null, table)
    if (n !== 0) noContext.push(`${table} showed ${n} rows`)
  }
  out.push({
    name: 'with no user, warren_app reads zero rows on every table',
    ok: noContext.length === 0,
    detail: noContext.join('; '),
  })

  const accepted: string[] = []
  for (const table of tables) {
    // B writes a row that says it is A's. Row-level security (or the missing grant) must refuse
    // it before anything else about the row is looked at.
    const error = await inUserContext(app, b, async (tx) => {
      await tx.execute(sql`insert into ${sql.identifier(table)} (user_id) values (${a}::uuid)`)
    }).then(
      () => null,
      (e: unknown) => String((e as { cause?: unknown; message?: string }).cause ?? e),
    )
    if (error === null) accepted.push(`${table}: accepted a row for another user`)
    else if (!refused.test(error))
      accepted.push(`${table}: refused for another reason: ${error.slice(0, 80)}`)
  }
  out.push({
    name: 'a user cannot insert a row that belongs to another user, on any table',
    ok: accepted.length === 0,
    detail: accepted.join('; '),
  })

  const touched = await inUserContext(
    app,
    b,
    async (tx) =>
      rowsOf<Row>(
        await tx.execute(
          sql`update movement set reason = 'tampered' where user_id = ${a}::uuid returning 1`,
        ),
      ).length,
  )
  const deleteError = await inUserContext(app, b, async (tx) => {
    await tx.execute(sql`delete from event where user_id = ${a}::uuid`)
  }).then(
    () => null,
    (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
  )
  out.push({
    name: "a user cannot update another user's movement or delete anyone's event",
    ok: touched === 0 && deleteError !== null && /permission denied|append-only/.test(deleteError),
    detail: `updated ${touched} rows; delete: ${deleteError ?? 'accepted'}`,
  })
  return out
}

/**
 * The user context does not leak between callers. Run it on a pool of one connection: the
 * calls queue on the same session, which is what the Neon pooler does between clients.
 */
export async function checkConcurrency({
  app,
  a,
  b,
  rounds = 10,
}: {
  app: Database
  a: string
  b: string
  rounds?: number
}): Promise<Check[]> {
  const seen = async (userId: string) =>
    asUser(app, userId, async (scope) => {
      await scope.tx.execute(sql`select pg_sleep(0.02)`)
      const me = rowsOf<{ id: string | null }>(
        await scope.tx.execute(sql`select app_user_id() as id`),
      )
      const n = rowsOf<{ n: number; others: number }>(
        await scope.tx.execute(
          sql`select count(*)::int as n,
                     count(*) filter (where user_id <> ${userId}::uuid)::int as others
              from event`,
        ),
      )
      return { me: me[0]?.id, n: n[0]?.n, others: n[0]?.others }
    })
  const problems: string[] = []
  for (let i = 0; i < rounds; i++) {
    const [ra, rb] = await Promise.all([seen(a), seen(b)])
    if (ra.me !== a || rb.me !== b) problems.push(`round ${i}: context was ${ra.me} / ${rb.me}`)
    if (ra.others !== 0 || rb.others !== 0) problems.push(`round ${i}: saw another user's events`)
  }
  const after = await inSystemContext(app, async (tx) => ({
    me: rowsOf<{ id: string | null }>(await tx.execute(sql`select app_user_id() as id`))[0]?.id,
    n: rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from event`))[0]?.n,
  }))
  if (after.me !== null) problems.push(`a later query still had a user: ${after.me}`)
  if (after.n !== 0) problems.push(`a later query with no user read ${after.n} events`)
  return [
    {
      name: `${rounds} rounds of two parallel asUser calls: each sees only itself, none leaks`,
      ok: problems.length === 0,
      detail: problems.slice(0, 4).join('; '),
    },
  ]
}

/** As `warren_auth`: the auth tables work, and no ledger table is readable. */
export async function checkAuthRole({
  auth,
  owner,
}: {
  auth: Database
  owner: Database
}): Promise<Check[]> {
  const tables = (await tenantTables(owner)).map((t) => t.name)
  const readable: string[] = []
  for (const table of tables) {
    const error = await inSystemContext(auth, async (tx) => {
      await tx.execute(sql`select 1 from ${sql.identifier(table)} limit 1`)
    }).then(
      () => null,
      (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
    )
    if (error === null || !/permission denied/.test(error)) readable.push(table)
  }
  const users = await inSystemContext(auth, async (tx) =>
    tx.select({ id: user.id }).from(user).where(eq(user.id, randomUUID())),
  )
  return [
    {
      name: 'warren_auth cannot read any ledger table, and can read the user table',
      ok: readable.length === 0 && users.length === 0,
      detail: readable.join(', '),
    },
  ]
}

/**
 * Runs `fn` with one policy dropped, then puts it back exactly as it was. The negative run:
 * a check that still passes with a policy gone proves nothing. Needs the owner role.
 */
export async function withPolicyDropped<T>(
  owner: Database,
  table: string,
  policy: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [def] = await query<{
    permissive: string
    cmd: string
    roles: string
    qual: string | null
    with_check: string | null
  }>(
    owner,
    sql`select permissive, cmd, roles::text as roles, qual, with_check
        from pg_policies
        where schemaname = 'public' and tablename = ${table} and policyname = ${policy}`,
  )
  if (!def) throw new Error(`no policy ${policy} on ${table}`)
  const roles = def.roles.replace(/[{}]/g, '').split(',').filter(Boolean).join(', ')
  const run = (ddl: string) => inSystemContext(owner, (tx) => tx.execute(sql.raw(ddl)))
  await run(`drop policy "${policy}" on "${table}"`)
  try {
    return await fn()
  } finally {
    await run(
      `create policy "${policy}" on "${table}" as ${def.permissive.toLowerCase()} for ${def.cmd.toLowerCase()} to ${roles}` +
        (def.qual ? ` using (${def.qual})` : '') +
        (def.with_check ? ` with check (${def.with_check})` : ''),
    )
  }
}

export type TenancyCheckOptions = {
  owner: Database
  app: Database
  /** A connection as warren_auth, when there is one. */
  auth?: Database
  /** The app over a pool of one connection, for the concurrency check. Defaults to `app`. */
  appPoolOfOne?: Database
}

/** The whole proof. Makes two users and their rows, so run it on a branch you can throw away. */
export async function runTenancyCheck(options: TenancyCheckOptions): Promise<Check[]> {
  const { owner, app, auth, appPoolOfOne } = options
  const a = await createTestUser(owner, 'tenancy-a')
  const b = await createTestUser(owner, 'tenancy-b')
  await seedFixtures(owner, app, a, 'a')
  await seedFixtures(owner, app, b, 'b')
  return [
    ...(await checkStructure(app)),
    ...(await checkErasure(app)),
    ...(await checkIsolation({ owner, app, a, b })),
    ...(await checkConcurrency({ app: appPoolOfOne ?? app, a, b })),
    ...(auth ? await checkAuthRole({ auth, owner }) : []),
  ]
}
