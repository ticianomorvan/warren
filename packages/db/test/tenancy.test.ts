import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { inSystemContext } from '../src/client'
import { verifyChain } from '../src/ledger'
import {
  checkAuthRole,
  checkConcurrency,
  checkErasure,
  checkIsolation,
  checkStructure,
  EXEMPT_KEYS,
  runTenancyCheck,
  seedFixtures,
  withPolicyDropped,
} from '../src/tenancy-check'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
  await seedFixtures(t.owner, t.app, a, 'a')
  await seedFixtures(t.owner, t.app, b, 'b')
})

const failures = (checks: { name: string; ok: boolean; detail?: string }[]) =>
  checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)

describe('tenancy', () => {
  it('as warren_app, A reads only A and B only B, on every table; no user reads nothing; no cross-user insert', async () => {
    const checks = await checkIsolation({ owner: t.owner, app: t.app, a, b })
    expect(checks).toHaveLength(4)
    expect(failures(checks)).toEqual([])
  })

  it('does not leak the user context between two parallel calls on one connection', async () => {
    expect(failures(await checkConcurrency({ app: t.app, a, b }))).toEqual([])
  })

  it('keeps warren_auth away from every ledger table', async () => {
    expect(failures(await checkAuthRole({ auth: t.auth, owner: t.owner }))).toEqual([])
  })

  it('refuses to run a user-less insert: user_id has no default outside a user', async () => {
    await expect(
      inSystemContext(t.app, (tx) =>
        tx.execute(
          sql`insert into blob_file (mail_id, pathname, mime, bytes) values (${'c'.repeat(64)}, 'p', 'm', 1)`,
        ),
      ),
    ).rejects.toThrow()
    const rows = await inSystemContext(t.owner, (tx) =>
      tx.execute(sql`select count(*)::int n from blob_file where pathname = 'p'`),
    )
    expect(JSON.stringify(rows)).toContain('"n":0')
  })

  it('keeps two chains that verify, one per user, with different heads', async () => {
    const ra = await verifyChain(t.app, a)
    const rb = await verifyChain(t.app, b)
    expect(ra).toMatchObject({ ok: true, events: 1, brokenAt: null })
    expect(rb).toMatchObject({ ok: true, events: 1, brokenAt: null })
    // Equal payloads, different users: the seed is the user id, so the hashes differ.
    expect(ra.head).not.toBe(rb.head)
  })

  it('lets two users hold the same mail account number, and the same bank account id', async () => {
    // Seeded for both: 'asset:bank:ars' and the same bank-label identifier. No key conflict.
    const rows = await inSystemContext(t.owner, (tx) =>
      tx.execute(sql`select count(*)::int n from account where id = 'asset:bank:ars'`),
    )
    expect(JSON.stringify(rows)).toContain('"n":2')
  })
})

describe('the meta test: the catalog says every table is covered', () => {
  it('passes on the baseline', async () => {
    expect(failures(await checkStructure(t.app))).toEqual([])
  })

  it('lists only the keys that are exempt on purpose', () => {
    expect(Object.keys(EXEMPT_KEYS)).toEqual([
      'mailbox_address_unique',
      'inbound_address_token_unique',
    ])
  })

  it('fails when a table has no policy', async () => {
    const ddl = (s: string) => inSystemContext(t.owner, (tx) => tx.execute(sql.raw(s)))
    await ddl('drop policy mail_delivery_select on mail_delivery')
    try {
      const bad = failures(await checkStructure(t.app))
      expect(bad).toHaveLength(1)
      expect(bad[0]).toContain('mail_delivery:select')
      // And the isolation check sees the hole too: with no select policy nothing is readable.
      const iso = failures(await checkIsolation({ owner: t.owner, app: t.app, a, b }))
      expect(iso.join('\n')).toContain('mail_delivery')
    } finally {
      await ddl(
        `create policy mail_delivery_select on mail_delivery as permissive for select to warren_app using (user_id = app_user_id())`,
      )
    }
    expect(failures(await checkStructure(t.app))).toEqual([])
  })

  it('fails when row-level security is switched off on a table', async () => {
    const ddl = (s: string) => inSystemContext(t.owner, (tx) => tx.execute(sql.raw(s)))
    await ddl('alter table notice disable row level security')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain('notice')
      expect(
        failures(await checkIsolation({ owner: t.owner, app: t.app, a, b })).join('\n'),
      ).toContain('notice')
    } finally {
      await ddl('alter table notice enable row level security')
    }
  })

  it('fails when a new table has no user_id, or a key that does not start with it', async () => {
    const ddl = (s: string) => inSystemContext(t.owner, (tx) => tx.execute(sql.raw(s)))
    await ddl('create table stray (id int primary key)')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain('stray')
    } finally {
      await ddl('drop table stray')
    }
    await ddl('alter table notice_attempt add constraint loose unique (id)')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain('notice_attempt.loose')
    } finally {
      await ddl('alter table notice_attempt drop constraint loose')
    }
    expect(failures(await checkStructure(t.app))).toEqual([])
  })

  it('fails when the app role may delete beyond the settings, or a setting loses its delete', async () => {
    const ddl = (s: string) => inSystemContext(t.owner, (tx) => tx.execute(sql.raw(s)))
    expect(failures(await checkStructure(t.app))).toEqual([])
    await ddl('grant delete on notice_attempt to warren_app')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain(
        'warren_app delete notice_attempt',
      )
    } finally {
      await ddl('revoke delete on notice_attempt from warren_app')
    }
    await ddl('drop policy push_subscription_delete on push_subscription')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain(
        'missing push_subscription:delete',
      )
    } finally {
      await ddl(
        'create policy push_subscription_delete on push_subscription as permissive for delete to warren_app using (user_id = app_user_id())',
      )
    }
    expect(failures(await checkStructure(t.app))).toEqual([])
  })

  it('fails when the app role is given a grant on an auth table', async () => {
    const ddl = (s: string) => inSystemContext(t.owner, (tx) => tx.execute(sql.raw(s)))
    await ddl('grant select on session to warren_app')
    try {
      expect(failures(await checkStructure(t.app)).join('\n')).toContain(
        'warren_app select session',
      )
    } finally {
      await ddl('revoke select on session from warren_app')
    }
  })
})

describe('the meta test: erasure covers everything', () => {
  const ddl = (statement: string) =>
    inSystemContext(t.owner, (tx) => tx.execute(sql.raw(statement)))

  it('passes on the baseline: the eraser can do exactly what the erasure set says', async () => {
    const checks = await checkErasure(t.app)
    expect(checks).toHaveLength(8)
    expect(failures(checks)).toEqual([])
  })

  it('fails when the eraser is given a grant outside the erasure set', async () => {
    await ddl('grant delete on mail_parse to warren_eraser')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('extra: mail_parse DELETE')
    } finally {
      await ddl('revoke delete on mail_parse from warren_eraser')
    }
  })

  it('fails when an erased table loses its grant, policy or trigger exception', async () => {
    await ddl('revoke delete on account from warren_eraser')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('missing: account DELETE')
    } finally {
      await ddl('grant delete on account to warren_eraser')
    }
    await ddl('drop policy account_identifier_erase_delete on account_identifier')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain(
        'missing: account_identifier DELETE',
      )
    } finally {
      await ddl(
        'create policy account_identifier_erase_delete on account_identifier as permissive for delete to warren_eraser using (user_id = app_user_id())',
      )
    }
    await ddl('drop trigger account_no_mutation on account')
    try {
      await ddl(
        'create trigger account_no_mutation before update or delete on account for each row execute function forbid_mutation()',
      )
      expect(failures(await checkErasure(t.app)).join('\n')).toContain(
        'account blocks every delete',
      )
    } finally {
      await ddl('drop trigger account_no_mutation on account')
      await ddl(
        'create trigger account_no_mutation before update or delete on account for each row execute function forbid_mutation_except_erasure()',
      )
    }
    await ddl(
      'create trigger event_x before update or delete on event for each row execute function forbid_mutation_except_erasure()',
    )
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain(
        'event lets the eraser delete but is not in the erasure set',
      )
    } finally {
      await ddl('drop trigger event_x on event')
    }
    expect(failures(await checkErasure(t.app))).toEqual([])
  })

  it('fails when warren_auth may delete a user row, or loses a delete erasure needs', async () => {
    await ddl('grant delete on "user" to warren_auth')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('extra: DELETE user')
    } finally {
      await ddl('revoke delete on "user" from warren_auth')
    }
    await ddl('revoke delete on session from warren_auth')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('missing: DELETE session')
    } finally {
      await ddl('grant delete on session to warren_auth')
    }
  })

  it('fails when the user row gains a column erasure does not know about', async () => {
    await ddl('alter table "user" add column phone text')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('user.phone is unreviewed')
    } finally {
      await ddl('alter table "user" drop column phone')
    }
  })

  it('fails when sessions can be made for an erased user', async () => {
    await ddl('drop trigger session_not_for_erased_user on session')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain(
        'session_not_for_erased_user is missing',
      )
    } finally {
      await ddl(
        'create trigger session_not_for_erased_user before insert on session for each row execute function refuse_session_for_erased_user()',
      )
    }
  })

  it('fails when a kept table gains a column that is neither sealed nor reviewed', async () => {
    await ddl('alter table inbound_mail add column sender_name text')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain(
        'inbound_mail.sender_name is neither sealed nor on the reviewed clear list',
      )
    } finally {
      await ddl('alter table inbound_mail drop column sender_name')
    }
  })

  it('fails when a table is added that no list mentions', async () => {
    await ddl('create table stray_notes (user_id uuid)')
    try {
      expect(failures(await checkErasure(t.app)).join('\n')).toContain('stray_notes is in no list')
    } finally {
      await ddl('drop table stray_notes')
    }
  })
})

describe('pnpm db:tenancy-check, as the script runs it', () => {
  const options = () => ({ owner: t.owner, app: t.app, auth: t.auth })

  it('passes on the baseline, every check', async () => {
    const checks = await runTenancyCheck(options())
    expect(checks.length).toBeGreaterThanOrEqual(15)
    expect(failures(checks)).toEqual([])
  })

  it('fails when one policy is dropped, and the policy comes back unchanged', async () => {
    const policy = async () =>
      JSON.stringify(
        await inSystemContext(t.owner, (tx) =>
          tx.execute(sql`select cmd, roles::text, qual, with_check from pg_policies
                         where policyname = 'mail_delivery_select'`),
        ),
      )
    const before = await policy()
    const checks = await withPolicyDropped(t.owner, 'mail_delivery', 'mail_delivery_select', () =>
      runTenancyCheck(options()),
    )
    expect(failures(checks).length).toBeGreaterThan(0)
    expect(await policy()).toBe(before)
    expect(failures(await checkStructure(t.app))).toEqual([])
  })
})
