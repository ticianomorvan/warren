import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser, inSystemContext, rowsOf } from '../src/client'
import {
  addressHash,
  claimMailbox,
  createForwardingConfirmations,
  mailboxesOf,
  pendingConfirmations,
} from '../src/forwarding'
import { createMailLog } from '../src/mail-log'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string
let b: string
const URL_ = 'https://mail-settings.google.com/mail/vf-invented'
const DAY = 86_400_000

const confirm = (user: string, address: string, daysAgo = 0) =>
  asUser(t.app, user, (s) =>
    createForwardingConfirmations(s).record(
      { address, url: URL_ },
      new Date(Date.now() - daysAgo * DAY),
    ),
  )
const claim = (user: string, address: string) =>
  asUser(t.app, user, (s) => claimMailbox(s, address))
const mailboxes = (user: string) => asUser(t.app, user, mailboxesOf)

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
  b = await t.newUser('b')
})

describe('forwarding confirmations', () => {
  it('seal the address and the link, and hash the address for the claim', async () => {
    await confirm(a, 'Ana@Gmail.com')
    const { rows } = await t.pg.query<{ data: Uint8Array; address_hash: string }>(
      'select data, address_hash from forwarding_confirmation where user_id = $1',
      [a],
    )
    const bytes = Buffer.from(rows[0]?.data ?? [])
    expect(bytes.includes(Buffer.from('gmail.com'))).toBe(false)
    expect(bytes.includes(Buffer.from('mail-settings'))).toBe(false)
    expect(rows[0]?.address_hash).toBe(addressHash('ana@gmail.com'))
    const got = await asUser(t.app, a, (s) => pendingConfirmations(s))
    expect(got).toMatchObject([{ address: 'ana@gmail.com', url: URL_ }])
    expect(await asUser(t.app, b, (s) => pendingConfirmations(s))).toEqual([])
  })

  it('are append-only for the app', async () => {
    const run = (statement: string) =>
      asUser(t.app, a, (s) => s.tx.execute(sql.raw(statement))).catch((e: unknown) => {
        throw new Error(String((e as { cause?: unknown }).cause ?? e))
      })
    await expect(run('update forwarding_confirmation set received_at = now()')).rejects.toThrow(
      /permission denied/,
    )
    await expect(run('delete from forwarding_confirmation')).rejects.toThrow(/permission denied/)
    await expect(
      t.pg.query('update forwarding_confirmation set address_hash = address_hash'),
    ).rejects.toThrow(/append-only/)
    await expect(t.pg.query('truncate forwarding_confirmation')).rejects.toThrow(/append-only/)
  })
})

describe('pendingConfirmations', () => {
  it('lists each address once, newest first, and leaves out expired ones', async () => {
    const c = await t.newUser('pend')
    await confirm(c, 'uno@gmail.com', 3)
    await confirm(c, 'dos@gmail.com', 2)
    await confirm(c, 'uno@gmail.com', 1)
    await confirm(c, 'viejo@gmail.com', 9)
    const got = await asUser(t.app, c, (s) => pendingConfirmations(s))
    expect(got.map((g) => g.address)).toEqual(['uno@gmail.com', 'dos@gmail.com'])
  })
})

describe('claim_mailbox', () => {
  it('claims an address the user has a recent confirmation for, whatever its case', async () => {
    expect(await claim(a, 'ana@gmail.com')).toBe('claimed')
    expect(await mailboxes(a)).toEqual(['ana@gmail.com'])
    expect(await claim(a, 'ANA@gmail.com')).toBe('already-yours')
  })

  it('refuses an address with no confirmation', async () => {
    expect(await claim(a, 'otra@gmail.com')).toBe('no-confirmation')
    expect(await mailboxes(a)).toEqual(['ana@gmail.com'])
  })

  it('refuses a confirmation older than 7 days', async () => {
    await confirm(a, 'vieja@gmail.com', 8)
    expect(await claim(a, 'vieja@gmail.com')).toBe('no-confirmation')
    await confirm(a, 'justa@gmail.com', 6)
    expect(await claim(a, 'justa@gmail.com')).toBe('claimed')
  })

  it("refuses another user's confirmation, and says nothing about who holds the address", async () => {
    await confirm(a, 'solo-de-a@gmail.com')
    expect(await claim(b, 'solo-de-a@gmail.com')).toBe('no-confirmation')
    // Even an address A already holds: B without a confirmation learns nothing.
    expect(await claim(b, 'ana@gmail.com')).toBe('no-confirmation')
    expect(await mailboxes(b)).toEqual([])
  })

  it('says taken when the confirmed address belongs to another user', async () => {
    await confirm(b, 'ana@gmail.com')
    expect(await claim(b, 'ana@gmail.com')).toBe('taken')
    expect(await mailboxes(b)).toEqual([])
    expect(await mailboxes(a)).toContain('ana@gmail.com')
  })

  it('does nothing without a user', async () => {
    const out = await inSystemContext(t.app, async (tx) =>
      rowsOf<{ s: string }>(await tx.execute(sql`select claim_mailbox('ana@gmail.com') as s`)),
    )
    expect(out[0]?.s).toBe('no-confirmation')
  })

  it('is security definer with a fixed search_path, executable by warren_app only, and the app still cannot insert a mailbox', async () => {
    const rows = await inSystemContext(t.owner, async (tx) =>
      rowsOf<{
        prosecdef: boolean
        cfg: string[]
        app: boolean
        auth: boolean
        eraser: boolean
        pub: boolean
      }>(
        await tx.execute(sql`
          select prosecdef, coalesce(proconfig, '{}') as cfg,
                 has_function_privilege('warren_app', oid, 'execute') as app,
                 has_function_privilege('warren_auth', oid, 'execute') as auth,
                 has_function_privilege('warren_eraser', oid, 'execute') as eraser,
                 has_function_privilege('public', oid, 'execute') as pub
          from pg_proc where proname = 'claim_mailbox'`),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      prosecdef: true,
      app: true,
      auth: false,
      eraser: false,
      pub: false,
    })
    expect(rows[0]?.cfg.join()).toContain('search_path=pg_catalog, pg_temp')
    // Drizzle wraps the driver's error: the "permission denied" is in its cause.
    await expect(
      asUser(t.app, a, (s) =>
        s.tx.execute(sql`insert into mailbox (address) values ('directo@gmail.com')`),
      ).catch((e: unknown) => {
        throw new Error(String((e as { cause?: unknown }).cause ?? e))
      }),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('rejectedNotAddressed', () => {
  it('lists recent mails whose latest verdict is that rejection, and not older or settled ones', async () => {
    const c = await t.newUser('c')
    const rejected = {
      verdict: 'rejected' as const,
      reason: 'not-addressed-to-user' as const,
      fromAddress: 'avisos@bbva.com.ar',
      senderId: 'bbva-transfers',
    }
    await asUser(t.app, c, async (s) => {
      const log = createMailLog(s)
      const mail = (n: string, at: Date) =>
        log.recordMail({
          mailId: n.repeat(64),
          pathname: `u/${c}/mail/${n.repeat(64)}.eml.sealed`,
          bytes: 1,
          provider: 'resend',
          providerId: n,
          receivedAt: at,
        })
      await mail('1', new Date(Date.now() - DAY))
      await mail('2', new Date(Date.now() - 9 * DAY))
      await mail('3', new Date(Date.now() - DAY))
      for (const n of ['1', '2', '3']) await log.recordVerdict(n.repeat(64), rejected, 1)
      await log.recordVerdict('3'.repeat(64), { ...rejected, reason: 'date-skew' }, 1)
    })
    const got = await asUser(t.app, c, (s) =>
      createMailLog(s).rejectedNotAddressed(new Date(Date.now() - 7 * DAY)),
    )
    expect(got.map((m) => m.mailId)).toEqual(['1'.repeat(64)])
  })
})

describe('rejectedUnknownSender', () => {
  it('lists mails whose latest verdict is that rejection under an older policy, whatever their age', async () => {
    const c = await t.newUser('d')
    const rejected = {
      verdict: 'rejected' as const,
      reason: 'unknown-sender' as const,
      fromAddress: 'transaction@belo.app',
    }
    await asUser(t.app, c, async (s) => {
      const log = createMailLog(s)
      const mail = (n: string, at: Date) =>
        log.recordMail({
          mailId: n.repeat(64),
          pathname: `u/${c}/mail/${n.repeat(64)}.eml.sealed`,
          bytes: 1,
          provider: 'resend',
          providerId: n,
          receivedAt: at,
        })
      await mail('1', new Date(Date.now() - 90 * DAY))
      await mail('2', new Date(Date.now() - DAY))
      await mail('3', new Date(Date.now() - DAY))
      await mail('4', new Date(Date.now() - DAY))
      for (const n of ['1', '2', '3', '4']) await log.recordVerdict(n.repeat(64), rejected, 1)
      // 2 was judged again under the current policy and is still unknown.
      await log.recordVerdict('2'.repeat(64), rejected, 2)
      // 3 now has another reason.
      await log.recordVerdict('3'.repeat(64), { ...rejected, reason: 'date-skew' }, 2)
    })
    const got = await asUser(t.app, c, (s) => createMailLog(s).rejectedUnknownSender(2))
    expect(got.map((m) => m.mailId)).toEqual(['1'.repeat(64), '4'.repeat(64)])
  })
})
