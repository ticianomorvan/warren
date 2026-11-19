import {
  type AccountSeed,
  type Accounts,
  type BankOperation,
  type Candidate,
  eventId,
  type Ledger,
  type MovementSource,
  matchMovement,
  mergeSources,
  type ParsedMail,
  type PendingMail,
  type RecordOptions,
  type RecordOutcome,
  TEMPLATE_SET_VERSION,
  type TransferOperation,
} from '@warren/core'
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  canonicalUserId,
  type Database,
  inUserContext,
  lockUserExclusive,
  rowsOf,
  type Scope,
  type Tx,
} from './client'
import {
  account,
  accountIdentifier,
  event,
  inboundMail,
  mailParse,
  movement,
  movementSource,
  notice,
} from './schema'

// Sealed here: an event's payload, a parse's operation, a source's operation. The scope adds
// the user to the associated data; these name the table, the row and the column.
const eventAad = (id: string) => `event:${id}:payload`
const sourceAad = (mailId: string) => `movement_source:${mailId}:operation`
const parseAad = (mailId: string, templateSetVersion: number) =>
  `mail_parse:${mailId}:${templateSetVersion}:operation`

const direction = (op: BankOperation) => (op.kind === 'transfer_in' ? 'in' : 'out')

type Scheme = 'cbu' | 'bank-label' | 'card-last-four'

// Functions the operator runs as the database owner (seedAccounts, reprojectMovements) name the
// user in every query: the owner is not bound by row-level security. The rest rely on it, and
// would show nothing of another user's even so.

async function accountFor(
  scope: Scope,
  scheme: Scheme,
  value: string | null,
): Promise<string | null> {
  if (value === null) return null
  const rows = await scope.tx
    .select({ accountId: accountIdentifier.accountId })
    .from(accountIdentifier)
    .where(
      and(
        eq(accountIdentifier.userId, scope.userId),
        eq(accountIdentifier.scheme, scheme),
        eq(accountIdentifier.value, value),
      ),
    )
    .limit(1)
  return rows[0]?.accountId ?? null
}

/**
 * The account a transfer that names no counterparty left from or went to, when another currency's
 * movement says so: exactly one movement of the same date and the same decimal digits, in the
 * other direction and another currency, whose own transfer targets this account. Digits are
 * compared, not converted: Warren never knows the rate. It must also be the only such movement
 * on this side: with two deposits of the same digits and one transfer out, neither is paired.
 * Zero or two on either side, none.
 */
async function otherCurrencyLeg(
  scope: Scope,
  movementId: string,
  op: TransferOperation,
  accountId: string | null,
): Promise<string | null> {
  if (accountId === null) return null
  const rivals = await scope.tx
    .select({ id: movement.id })
    .from(movement)
    .where(
      and(
        eq(movement.userId, scope.userId),
        ne(movement.id, movementId),
        eq(movement.accountId, accountId),
        eq(movement.date, op.date),
        sql`${movement.amount} = ${op.amount}::numeric`,
        eq(movement.currency, op.currency),
        eq(movement.direction, direction(op)),
        isNull(movement.counterpartyAccount),
        ne(movement.type, 'card_purchase'),
      ),
    )
    .limit(1)
  if (rivals.length > 0) return null
  const rows = await scope.tx
    .select({ accountId: movement.accountId })
    .from(movement)
    .where(
      and(
        eq(movement.userId, scope.userId),
        eq(movement.date, op.date),
        sql`${movement.amount} = ${op.amount}::numeric`,
        ne(movement.currency, op.currency),
        ne(movement.direction, direction(op)),
        eq(movement.type, 'own_transfer'),
        eq(movement.counterAccountId, accountId),
        isNotNull(movement.accountId),
        isNotNull(movement.counterpartyAccount),
      ),
    )
  return rows.length === 1 ? (rows[0]?.accountId ?? null) : null
}

/** The derived row for a movement: its sources merged, and its accounts resolved. */
async function projection(
  scope: Scope,
  movementId: string,
  sources: MovementSource[],
  lastEventSeq: number,
) {
  const op = mergeSources(sources)
  if (op.kind === 'card_purchase') {
    return {
      direction: direction(op),
      amount: op.amount,
      currency: op.currency,
      date: op.date,
      time: null,
      accountId: await accountFor(scope, 'card-last-four', op.cardLastFour),
      counterAccountId: null,
      counterpartyName: op.merchant,
      counterpartyAccount: null,
      counterpartyTaxId: null,
      reference: null,
      reason: null,
      cardLastFour: op.cardLastFour,
      type: 'card_purchase' as const,
      lastEventSeq,
    }
  }
  const accountId = await accountFor(scope, 'bank-label', op.ownAccount)
  // A source that names a counterparty account says which account it is. One that names none (a
  // wallet's) can still be the other currency's leg of a transfer another source describes.
  // A mail of the other direction on the same movement sits on the counter account: a leg joined
  // by the accounts it mirrors, or by saying "own account" (see `matchMovement`).
  const other = sources
    .map((s) => s.operation)
    .find((o): o is TransferOperation => o.kind !== 'card_purchase' && o.kind !== op.kind)
  const counterAccountId =
    (await accountFor(scope, 'cbu', op.counterparty.account)) ??
    (await accountFor(scope, 'bank-label', other?.ownAccount ?? null)) ??
    (op.counterparty.account === null
      ? await otherCurrencyLeg(scope, movementId, op, accountId)
      : null)
  return {
    direction: direction(op),
    amount: op.amount,
    currency: op.currency,
    date: op.date,
    time: op.time,
    accountId,
    counterAccountId,
    counterpartyName: op.counterparty.name,
    counterpartyAccount: op.counterparty.account,
    counterpartyTaxId: op.counterparty.taxId,
    reference: op.reference,
    reason: op.reason,
    cardLastFour: null,
    type: counterAccountId ? ('own_transfer' as const) : ('unclassified' as const),
    lastEventSeq,
  }
}

/**
 * Projects again the movements whose account comes from another currency's leg (see
 * `otherCurrencyLeg`) and could be affected by this operation: those of its date and digits that
 * name no counterparty account, in any currency, since a second wallet deposit also takes the
 * pairing away from the first. Whichever mail came first, the pair is found once both are in.
 */
async function settleOtherCurrencyLegs(scope: Scope, op: TransferOperation): Promise<void> {
  const rows = await scope.tx
    .select({ id: movement.id, seq: movement.lastEventSeq })
    .from(movement)
    .where(
      and(
        eq(movement.userId, scope.userId),
        eq(movement.date, op.date),
        sql`${movement.amount} = ${op.amount}::numeric`,
        isNull(movement.counterpartyAccount),
        ne(movement.type, 'card_purchase'),
      ),
    )
  const sources = await sourcesOf(
    scope,
    rows.map((r) => r.id),
  )
  for (const r of rows) {
    const next = await projection(scope, r.id, sources.get(r.id) ?? [], r.seq)
    await scope.tx
      .update(movement)
      .set(next)
      .where(and(eq(movement.userId, scope.userId), eq(movement.id, r.id)))
  }
}

async function sourcesOf(
  scope: Scope,
  movementIds: string[],
): Promise<Map<string, MovementSource[]>> {
  const out = new Map<string, MovementSource[]>()
  if (movementIds.length === 0) return out
  const rows = await scope.tx
    .select()
    .from(movementSource)
    .where(
      and(eq(movementSource.userId, scope.userId), inArray(movementSource.movementId, movementIds)),
    )
    .orderBy(asc(movementSource.eventSeq))
  for (const r of rows) {
    const list = out.get(r.movementId) ?? []
    list.push({
      mailId: r.mailId,
      templateId: r.templateId,
      operation: scope.json.open<BankOperation>(r.operation, sourceAad(r.mailId)),
    })
    out.set(r.movementId, list)
  }
  return out
}

/** One user's ledger. */
export function createLedger(scope: Scope): Ledger {
  const { tx } = scope
  return {
    async recordMailOperation(mail: ParsedMail, options: RecordOptions): Promise<RecordOutcome> {
      // One recording at a time per user, so two mails of one operation cannot both create a
      // movement. Taken before any insert, so the order of `seq` is the order of the chain.
      await lockUserExclusive(tx, scope.userId, 4202)

      const existing = await tx
        .select({ movementId: movementSource.movementId, type: movement.type })
        .from(movementSource)
        .innerJoin(movement, eq(movement.id, movementSource.movementId))
        .where(eq(movementSource.mailId, mail.mailId))
        .limit(1)
      if (existing[0]) {
        return {
          movementId: existing[0].movementId,
          outcome: 'duplicate',
          type: existing[0].type as RecordOutcome['type'],
        }
      }

      const op = mail.operation
      // Either direction: the other bank's leg of a transfer is the opposite one.
      const rows = await tx
        .select({
          id: movement.id,
          accountId: movement.accountId,
          counterAccountId: movement.counterAccountId,
        })
        .from(movement)
        .innerJoin(event, eq(event.id, movement.id))
        .where(
          and(
            eq(movement.date, op.date),
            eq(movement.amount, op.amount),
            eq(movement.currency, op.currency),
          ),
        )
        .orderBy(asc(event.seq))
      const known = await sourcesOf(
        scope,
        rows.map((r) => r.id),
      )
      const candidates: Candidate[] = rows.map((r) => ({
        movementId: r.id,
        sources: known.get(r.id) ?? [],
        accounts: { own: r.accountId, counter: r.counterAccountId },
      }))
      const accounts: Accounts | undefined =
        op.kind === 'card_purchase'
          ? undefined
          : {
              own: await accountFor(scope, 'bank-label', op.ownAccount),
              counter: await accountFor(scope, 'cbu', op.counterparty.account),
            }
      const matched = matchMovement({ ...mail, accounts }, candidates)

      const movementId = matched ?? eventId('movement', mail.mailId)
      const source: MovementSource = {
        mailId: mail.mailId,
        templateId: mail.templateId,
        operation: op,
      }
      const id = matched ? eventId('link', mail.mailId) : movementId
      const inserted = await tx
        .insert(event)
        .values({
          id,
          kind: matched ? 'link' : 'movement',
          subject: movementId,
          payload: scope.json.seal({ source: 'mail', ...source }, eventAad(id)),
          actor: 'core',
        })
        .returning({ seq: event.seq })
      const seq = inserted[0]?.seq
      if (seq === undefined) throw new Error('event insert returned no row')

      const sources = [...(known.get(movementId) ?? []), source]
      const row = await projection(scope, movementId, sources, seq)
      if (matched) {
        await tx
          .update(movement)
          .set(row)
          .where(and(eq(movement.userId, scope.userId), eq(movement.id, movementId)))
      } else {
        await tx.insert(movement).values({ id: movementId, ...row })
        // A movement first seen in a mail is news for the user; a later mail of it is not, and
        // neither is one a rebuild or an import recreates (`notify: false`).
        if (options.notify) await tx.insert(notice).values({ movementId })
      }
      await tx.insert(movementSource).values({
        mailId: mail.mailId,
        movementId,
        templateId: mail.templateId,
        operation: scope.json.seal(op, sourceAad(mail.mailId)),
        eventSeq: seq,
      })
      if (op.kind !== 'card_purchase') await settleOtherCurrencyLegs(scope, op)
      return { movementId, outcome: matched ? 'linked' : 'created', type: row.type }
    },

    async pendingMailOperations(): Promise<PendingMail[]> {
      const rows = await tx
        .select({
          mailId: mailParse.mailId,
          templateId: mailParse.templateId,
          operation: mailParse.operation,
          receivedAt: inboundMail.receivedAt,
        })
        .from(mailParse)
        .innerJoin(
          inboundMail,
          and(eq(inboundMail.userId, mailParse.userId), eq(inboundMail.mailId, mailParse.mailId)),
        )
        .leftJoin(movementSource, eq(movementSource.mailId, mailParse.mailId))
        .where(
          and(
            eq(mailParse.status, 'parsed'),
            eq(mailParse.templateSetVersion, TEMPLATE_SET_VERSION),
            isNull(movementSource.mailId),
          ),
        )
        .orderBy(asc(mailParse.id))
      return rows.flatMap((r) =>
        r.templateId && r.operation
          ? [
              {
                mailId: r.mailId,
                templateId: r.templateId,
                receivedAt: r.receivedAt,
                operation: scope.json.open<BankOperation>(
                  r.operation,
                  parseAad(r.mailId, TEMPLATE_SET_VERSION),
                ),
              },
            ]
          : [],
      )
    },
  }
}

/** Adds the user's accounts and identifiers that are not there yet. Operator, as owner. */
export async function seedAccounts(scope: Scope, seeds: readonly AccountSeed[]): Promise<void> {
  const { tx, userId } = scope
  for (const { identifiers, ...row } of seeds) {
    await tx
      .insert(account)
      .values({ userId, ...row })
      .onConflictDoNothing()
    for (const identifier of identifiers) {
      await tx
        .insert(accountIdentifier)
        .values({ userId, ...identifier, accountId: row.id })
        .onConflictDoNothing()
    }
  }
}

/**
 * Recomputes every movement row of the user from its sources and the current accounts. Needed
 * after accounts change, since "own transfer" and a card's account depend on them. Returns how
 * many rows changed type or account.
 */
export async function reprojectMovements(scope: Scope): Promise<number> {
  const { tx, userId } = scope
  await lockUserExclusive(tx, userId, 4202)
  const rows = await tx
    .select({
      id: movement.id,
      type: movement.type,
      accountId: movement.accountId,
      counterpartyAccount: movement.counterpartyAccount,
      seq: movement.lastEventSeq,
    })
    .from(movement)
    .where(eq(movement.userId, userId))
  const sources = await sourcesOf(
    scope,
    rows.map((r) => r.id),
  )
  let changed = 0
  // Movements that name no counterparty account may take theirs from another's: those go last.
  rows.sort(
    (a, b) => Number(a.counterpartyAccount === null) - Number(b.counterpartyAccount === null),
  )
  for (const r of rows) {
    const next = await projection(scope, r.id, sources.get(r.id) ?? [], r.seq)
    if (next.type !== r.type || next.accountId !== r.accountId) changed++
    await tx
      .update(movement)
      .set(next)
      .where(and(eq(movement.userId, userId), eq(movement.id, r.id)))
  }
  return changed
}

export type MovementRow = typeof movement.$inferSelect & { sources: number }

/** The user's latest movements, newest first. */
export async function recentMovements(scope: Scope, limit = 20): Promise<MovementRow[]> {
  const { tx } = scope
  const counts = tx
    .select({ id: movementSource.movementId, n: sql<number>`count(*)::int`.as('n') })
    .from(movementSource)
    .groupBy(movementSource.movementId)
    .as('counts')
  const rows = await tx
    .select({ movement, sources: counts.n })
    .from(movement)
    .innerJoin(counts, eq(counts.id, movement.id))
    .orderBy(sql`${movement.date} desc, ${movement.lastEventSeq} desc`)
    .limit(limit)
  return rows.map((r) => ({ ...r.movement, sources: r.sources }))
}

/** The kinds of movement, as the `movement_type` check allows them. */
export const MOVEMENT_TYPES = ['own_transfer', 'unclassified', 'card_purchase'] as const

export type MovementListItem = {
  id: string
  /** yyyy-mm-dd */
  date: string
  time: string | null
  type: (typeof MOVEMENT_TYPES)[number]
  direction: 'in' | 'out'
  /** Decimal string, as stored. */
  amount: string
  currency: string
  /** The merchant of a card purchase, or the other party of a transfer. */
  counterpartyName: string | null
  accountName: string | null
  counterAccountName: string | null
  cardLastFour: string | null
}

export type MovementPage = { items: MovementListItem[]; next: string | null }

const CURSOR = /^(\d{4}-\d{2}-\d{2})_(\d{1,15})$/

/**
 * One page of the user's movements, newest first (the order of `recentMovements`), with the
 * names of the accounts. `cursor` is the `next` of the page before, or null for the first
 * page; one that is not a cursor is taken as null. Keyset paging: a page costs the same
 * however far in it is.
 */
export async function listMovements(
  scope: Scope,
  cursor: string | null,
  limit = 25,
): Promise<MovementPage> {
  const own = alias(account, 'own')
  const counter = alias(account, 'counter')
  const after = cursor ? CURSOR.exec(cursor) : null
  const rows = await scope.tx
    .select({ movement, own: own.name, counter: counter.name })
    .from(movement)
    .leftJoin(own, eq(own.id, movement.accountId))
    .leftJoin(counter, eq(counter.id, movement.counterAccountId))
    .where(
      after
        ? sql`(${movement.date}, ${movement.lastEventSeq}) < (${after[1]}::date, ${Number(after[2])})`
        : undefined,
    )
    .orderBy(sql`${movement.date} desc, ${movement.lastEventSeq} desc`)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)?.movement
  return {
    items: page.map(({ movement: m, own: ownName, counter: counterName }) => ({
      id: m.id,
      date: m.date,
      time: m.time,
      type: m.type as MovementListItem['type'],
      direction: m.direction as MovementListItem['direction'],
      amount: m.amount,
      currency: m.currency,
      counterpartyName: m.counterpartyName,
      accountName: ownName,
      counterAccountName: counterName,
      cardLastFour: m.cardLastFour,
    })),
    next: rows.length > limit && last ? `${last.date}_${last.lastEventSeq}` : null,
  }
}

/** Totals of one group of movements: decimal strings, summed by the database as `numeric`. */
export type MovementTotals = {
  /** Movements in the group. */
  count: number
  /** Money received. */
  in: string
  /** Money spent. */
  out: string
  /** `in` minus `out`; negative when more went out than came in. */
  net: string
}

export type CurrencySummary = MovementTotals & {
  currency: string
  by_type: (MovementTotals & { type: MovementListItem['type'] })[]
  by_account: (MovementTotals & { account: string | null })[]
}

export type MovementSummary = {
  /** Spending and income per currency. Own transfers are not in these totals. */
  currencies: CurrencySummary[]
  /** Transfers to an account registered as the user's own, apart: not spending or income. */
  own_transfers: { currency: string; count: number; in: string; out: string }[]
}

type SummaryRow = {
  currency: string
  own: boolean
  type: MovementListItem['type'] | null
  account: string | null
  /** `grouping(type, account)`: 3 per currency, 1 per type, 2 per account. */
  level: number
  count: number
  in: string
  out: string
  net: string
}

const PER_CURRENCY = 3
const PER_TYPE = 1
const PER_ACCOUNT = 2

/**
 * The user's totals for movements dated `from` to `to`, both included (yyyy-mm-dd): per
 * currency, in, out and net, by type and by account. One query (one snapshot): every sum is
 * made in SQL as `numeric`, so no number passes through a float, and returns a decimal
 * string. Movements of type `own_transfer`, those to an account registered as the user's own
 * (`counter_account_id`), are reported apart from the totals.
 */
export async function summarizeMovements(
  scope: Scope,
  { from, to }: { from: string; to: string },
): Promise<MovementSummary> {
  const rows = rowsOf<SummaryRow>(
    await scope.tx.execute(sql`
      select m.currency, m.own, m.type, m.account,
             grouping(m.type, m.account)::int as level,
             count(*)::int as count,
             coalesce(sum(m.amount) filter (where m.direction = 'in'), 0::numeric(28,8))::text as "in",
             coalesce(sum(m.amount) filter (where m.direction = 'out'), 0::numeric(28,8))::text as "out",
             (coalesce(sum(m.amount) filter (where m.direction = 'in'), 0::numeric(28,8))
              - coalesce(sum(m.amount) filter (where m.direction = 'out'), 0::numeric(28,8)))::text as net
      from (
        select x.*, (x.type = 'own_transfer') as own, a.name as account
        from movement x
        left join account a on a.user_id = x.user_id and a.id = x.account_id
        where x.date >= ${from}::date and x.date <= ${to}::date
      ) m
      group by grouping sets ((m.currency, m.own), (m.currency, m.own, m.type), (m.currency, m.own, m.account))
      order by m.currency, m.type, m.account nulls last`),
  )
  const totals = (r: SummaryRow): MovementTotals => ({
    count: Number(r.count),
    in: r.in,
    out: r.out,
    net: r.net,
  })
  const at = (level: number, currency: string) =>
    rows.filter((r) => !r.own && r.level === level && r.currency === currency)
  return {
    currencies: rows
      .filter((r) => !r.own && r.level === PER_CURRENCY)
      .map((r) => ({
        currency: r.currency,
        ...totals(r),
        by_type: at(PER_TYPE, r.currency).map((t) => ({
          type: t.type as MovementListItem['type'],
          ...totals(t),
        })),
        by_account: at(PER_ACCOUNT, r.currency).map((a) => ({ account: a.account, ...totals(a) })),
      })),
    own_transfers: rows
      .filter((r) => r.own && r.level === PER_CURRENCY)
      .map((r) => ({ currency: r.currency, count: Number(r.count), in: r.in, out: r.out })),
  }
}

/** How many movements the user has. */
export async function movementCount(scope: Scope): Promise<number> {
  const rows = await scope.tx.select({ n: sql<number>`count(*)::int` }).from(movement)
  return rows[0]?.n ?? 0
}

export type ChainReport = {
  ok: boolean
  events: number
  /** The last link, hex; null when the user has no events. */
  head: string | null
  /** The first `seq` whose payload or link does not match, when not ok. */
  brokenAt: number | null
}

/**
 * Recomputes a user's hash chain from the stored rows: each payload hash from the sealed
 * bytes, each link from the one before it. Needs no key, so it holds after the key is gone.
 * Runs under the user's row-level security.
 */
export async function verifyChain(database: Database, id: string): Promise<ChainReport> {
  const userId = canonicalUserId(id)
  return inUserContext(database, userId, (tx) => verifyChainIn(tx, userId))
}

async function verifyChainIn(tx: Tx, userId: string): Promise<ChainReport> {
  const rows = rowsOf<{ seq: string; ok: boolean; chain: string }>(
    await tx.execute(sql`
    select seq::text,
           (payload_sha256 = sha256(payload)
            and chain_sha256 = sha256(
              coalesce(prev, sha256(convert_to('warren:' || ${userId}::text, 'UTF8')))
              || payload_sha256)) as ok,
           encode(chain_sha256, 'hex') as chain
    from (
      select seq, payload, payload_sha256, chain_sha256,
             lag(chain_sha256) over (order by seq) as prev
      from event
      where user_id = ${userId}::uuid
    ) e
    order by seq`),
  )
  const broken = rows.find((r) => !r.ok)
  return {
    ok: !broken,
    events: rows.length,
    head: rows.at(-1)?.chain ?? null,
    brokenAt: broken ? Number(broken.seq) : null,
  }
}
