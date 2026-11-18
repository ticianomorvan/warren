import { randomUUID } from 'node:crypto'
import { newDataKey, type RawStore, SealError, userFilesPrefix } from '@warren/core'
import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { setCredentialPassword } from '../src/auth'
import { asUser, inSystemContext, inUserContext, UserErasedError } from '../src/client'
import { sealedStore } from '../src/context'
import { eraseUser } from '../src/erase'
import { verifyChain } from '../src/ledger'
import { authAccount, session, user as userTable } from '../src/schema'
import { seedFixtures } from '../src/tenancy-check'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string
const files = new Map<string, Uint8Array>()
const store: RawStore = {
  put: async (p, bytes) => void files.set(p, bytes),
  get: async (p) => files.get(p) ?? null,
  deletePrefix: async (prefix) => {
    const gone = [...files.keys()].filter((p) => p.startsWith(prefix))
    for (const p of gone) files.delete(p)
    return gone.length
  },
}
const mailPath = (user: string) => `${userFilesPrefix(user)}mail/${'f'.repeat(64)}.eml.sealed`

const owned = async (table: string, user: string) => {
  const { rows } = await t.pg.query<{ n: number }>(
    `select count(*)::int n from ${table} where user_id = $1`,
    [user],
  )
  return rows[0]?.n ?? -1
}
const DERIVED = [
  'movement',
  'movement_source',
  'notice',
  'mailbox',
  'user_key',
  'push_subscription',
  'account',
  'account_identifier',
]
const KEPT = [
  'event',
  'mail_parse',
  'mail_verdict',
  'inbound_mail',
  'blob_file',
  'notice_attempt',
  'notice_status',
]

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
  for (const [user, tag] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    await seedFixtures(t.owner, t.app, user, tag, { tombstone: false })
    await asUser(t.app, user, (scope) =>
      sealedStore(store, scope).put(
        mailPath(user),
        Buffer.from(`raw mail of ${tag}`),
        'message/rfc822',
      ),
    )
    // Signed in: a credential and a session, as Better Auth would have made them.
    await setCredentialPassword(t.auth, user, `hash-${tag}`)
    await inSystemContext(t.auth, (tx) =>
      tx
        .insert(session)
        .values({ userId: user, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }),
    )
  }
})

/** What `warren_auth` holds for a user: their row, sessions and credentials. */
const authRows = (id: string) =>
  inSystemContext(t.auth, async (tx) => ({
    user: (await tx.select().from(userTable).where(eq(userTable.id, id)))[0],
    sessions: (await tx.select().from(session).where(eq(session.userId, id))).length,
    credentials: (await tx.select().from(authAccount).where(eq(authAccount.userId, id))).length,
  }))

describe('erasing a user', () => {
  let headA: string | null
  let headB: string | null
  let sealedPayloadB: Buffer
  let report: Awaited<ReturnType<typeof eraseUser>>

  it('has two users with verifying chains and readable data before', async () => {
    headA = (await verifyChain(t.app, a)).head
    headB = (await verifyChain(t.app, b)).head
    expect(headA).not.toBeNull()
    expect((await verifyChain(t.app, b)).ok).toBe(true)
    const { rows } = await t.pg.query<{ payload: Uint8Array }>(
      'select payload from event where user_id = $1',
      [b],
    )
    sealedPayloadB = Buffer.from(rows[0]?.payload ?? [])
    const eventId = (
      await t.pg.query<{ id: string }>('select id from event where user_id = $1', [b])
    ).rows[0]?.id
    const payload = await asUser(t.app, b, async (scope) =>
      scope.json.open<{ source: string }>(sealedPayloadB, `event:${eventId}:payload`),
    )
    expect(payload.source).toBe('mail')
    expect(await sealedStore(store, await keyless(b)).get(mailPath(b))).not.toBeNull()
    for (const table of DERIVED) expect(await owned(table, b)).toBeGreaterThan(0)
  })

  it('deletes the derived rows, writes a tombstone and deletes the files', async () => {
    report = await eraseUser(t, b, store)
    expect(report).toEqual({
      chainHead: headB,
      files: 1,
      alreadyErased: false,
      auth: { sessions: 1, accounts: 1 },
    })
    for (const table of DERIVED) expect(await owned(table, b)).toBe(0)
    for (const table of KEPT) expect(await owned(table, b)).toBeGreaterThan(0)
    const { rows } = await t.pg.query<{ head: string }>(
      "select encode(chain_head, 'hex') head from erasure where user_id = $1",
      [b],
    )
    expect(rows[0]?.head).toBe(headB)
    expect([...files.keys()]).toEqual([mailPath(a)])
  })

  it('ends their sign-in: no session or credential is left, and the row holds no email or name', async () => {
    const gone = await authRows(b)
    expect(gone).toMatchObject({ sessions: 0, credentials: 0 })
    expect(gone.user).toMatchObject({
      email: `erased+${b}@invalid`,
      name: 'erased',
      image: null,
      emailVerified: false,
    })
    expect(gone.user?.erasedAt).toBeInstanceOf(Date)
    expect(JSON.stringify(gone.user)).not.toMatch(/example\.invalid|^b-/)
    // The row stays: every user_id points at it.
    expect(await owned('event', b)).toBeGreaterThan(0)
  })

  it('refuses to give an erased user a session or a password again', async () => {
    await expect(
      inSystemContext(t.auth, (tx) =>
        tx
          .insert(session)
          .values({ userId: b, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }),
      ),
    ).rejects.toThrow()
    expect(await setCredentialPassword(t.auth, b, 'hash-new')).toBe('erased')
    expect(await authRows(b)).toMatchObject({ sessions: 0, credentials: 0 })
  })

  it("leaves the other user's sign-in untouched", async () => {
    expect(await authRows(a)).toMatchObject({ sessions: 1, credentials: 1 })
    expect((await authRows(a)).user?.email).toMatch(/^a-.*@example\.invalid$/)
  })

  it("leaves the other user's chain, data and files untouched", async () => {
    expect(await verifyChain(t.app, a)).toMatchObject({ ok: true, head: headA })
    for (const table of [...DERIVED, ...KEPT]) expect(await owned(table, a)).toBeGreaterThan(0)
    const mail = await asUser(t.app, a, async (scope) => sealedStore(store, scope).get(mailPath(a)))
    expect(Buffer.from(mail ?? []).toString()).toBe('raw mail of a')
  })

  it('still verifies the erased user chain, over ciphertext, with the same head', async () => {
    expect(await verifyChain(t.app, b)).toMatchObject({ ok: true, head: headB })
  })

  it('cannot open the erased user sealed columns any more, with any key', async () => {
    expect(await owned('user_key', b)).toBe(0)
    const eventId = (
      await t.pg.query<{ id: string }>('select id from event where user_id = $1', [b])
    ).rows[0]?.id
    const aad = `${b}:event:${eventId}:payload`
    const { open } = await import('@warren/core')
    expect(() => open(newDataKey(), sealedPayloadB, aad)).toThrow(SealError)
    // Not even user A's key opens it.
    await asUser(t.app, a, async (scope) => {
      expect(() => scope.open(sealedPayloadB, `event:${eventId}:payload`)).toThrow(SealError)
    })
  })

  it('refuses to make a new key for an erased user, so they cannot be revived', async () => {
    await expect(asUser(t.app, b, async () => {})).rejects.toBeInstanceOf(UserErasedError)
    expect(await owned('user_key', b)).toBe(0)
  })

  it('can be run again: only the files are swept', async () => {
    files.set(mailPath(b), new Uint8Array([1]))
    expect(await eraseUser(t, b, store)).toEqual({
      chainHead: null,
      files: 1,
      alreadyErased: true,
      auth: { sessions: 0, accounts: 0 },
    })
  })

  it('notices tampering with one chain without touching the other', async () => {
    const { rows } = await t.pg.query<{ seq: string; payload: Uint8Array }>(
      'select seq::text, payload from event where user_id = $1',
      [a],
    )
    const first = rows[0]
    if (!first) throw new Error('no event')
    const set = (payload: Uint8Array) =>
      t.pg.query('update event set payload = $1 where seq = $2', [payload, first.seq])
    await t.pg.exec('alter table event disable trigger event_no_mutation')
    try {
      await set(new Uint8Array([9]))
      expect((await verifyChain(t.app, a)).ok).toBe(false)
      expect((await verifyChain(t.app, b)).ok).toBe(true)
    } finally {
      await set(first.payload)
      await t.pg.exec('alter table event enable trigger event_no_mutation')
    }
    expect((await verifyChain(t.app, a)).ok).toBe(true)
  })
})

describe('the erasure role', () => {
  it('can do nothing beyond erasure', async () => {
    const attempt = (statement: string) =>
      inUserContext(t.eraser, a, (tx) => tx.execute(sql.raw(statement)))
    await expect(attempt('delete from event')).rejects.toThrow()
    await expect(attempt('select * from mail_verdict')).rejects.toThrow()
    await expect(attempt('select payload from event')).rejects.toThrow()
    await expect(attempt('delete from mail_delivery')).rejects.toThrow()
    await expect(attempt('select name from account')).rejects.toThrow()
    await expect(attempt('delete from notice_attempt')).rejects.toThrow()
    await expect(attempt('update movement set reason = null')).rejects.toThrow()
    await expect(attempt('select 1 from "user"')).rejects.toThrow()
  })

  it('cannot erase one user while acting as another', async () => {
    // Acting as C, the policies show it nothing of A's: the delete touches zero rows.
    const c = await t.newUser('c')
    const before = await owned('movement', a)
    await inUserContext(t.eraser, c, (tx) =>
      tx.execute(sql`delete from movement where user_id = ${a}::uuid`),
    )
    expect(await owned('movement', a)).toBe(before)
  })

  it('cannot erase a user that does not exist', async () => {
    await expect(eraseUser(t, randomUUID(), store)).rejects.toThrow(/no user/)
  })

  it('is the only role that may delete a notice', async () => {
    await expect(t.pg.query('delete from notice')).rejects.toThrow(/append-only/)
    await expect(
      inUserContext(t.app, a, (tx) => tx.execute(sql`delete from notice`)),
    ).rejects.toThrow()
  })
})

/** A scope without an unwrapped key is not a thing; this opens a user's scope only to reuse its store. */
async function keyless(user: string) {
  return asUser(t.app, user, async (scope) => scope)
}
