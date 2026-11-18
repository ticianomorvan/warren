import {
  type AccountSeed,
  type BankOperation,
  type Candidate,
  eventId,
  type Ledger,
  type MovementSource,
  matchMovement,
  mergeSources,
  type ParsedMail,
  type RecordOutcome,
  TEMPLATE_SET_VERSION,
} from '@warren/core'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  canonicalUserId,
  type Database,
  inUserContext,
  lockUser,
  rowsOf,
  type Scope,
  type Tx,
} from './client'
import {
  account,
  accountIdentifier,
  event,
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

// Functions the operator runs as the database owner (seedAccounts, reprojectMovements) name the
// user in every query: the owner is not bound by row-level security. The rest rely on it, and
// would show nothing of another user's even so.

async function accountFor(
  scope: Scope,
  scheme: 'cbu' | 'bank-label',
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

/** The derived row for a movement: its sources merged, and its accounts resolved. */
async function projection(scope: Scope, sources: MovementSource[], lastEventSeq: number) {
  const op = mergeSources(sources)
  const counterAccountId = await accountFor(scope, 'cbu', op.counterparty.account)
  return {
    direction: direction(op),
    amount: op.amount,
    currency: op.currency,
    date: op.date,
    time: op.time,
    accountId: await accountFor(scope, 'bank-label', op.ownAccount),
    counterAccountId,
    counterpartyName: op.counterparty.name,
    counterpartyAccount: op.counterparty.account,
    counterpartyTaxId: op.counterparty.taxId,
    reference: op.reference,
    reason: op.reason,
    type: counterAccountId ? ('own_transfer' as const) : ('unclassified' as const),
    lastEventSeq,
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
    async recordMailOperation(mail: ParsedMail): Promise<RecordOutcome> {
      // One recording at a time per user, so two mails of one operation cannot both create a
      // movement. Taken before any insert, so the order of `seq` is the order of the chain.
      await lockUser(tx, scope.userId, 4202)

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
      const rows = await tx
        .select({ id: movement.id })
        .from(movement)
        .innerJoin(event, eq(event.id, movement.id))
        .where(
          and(
            eq(movement.date, op.date),
            eq(movement.amount, op.amount),
            eq(movement.currency, op.currency),
            eq(movement.direction, direction(op)),
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
      }))
      const matched = matchMovement(mail, candidates)

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
      const row = await projection(scope, sources, seq)
      if (matched) {
        await tx
          .update(movement)
          .set(row)
          .where(and(eq(movement.userId, scope.userId), eq(movement.id, movementId)))
      } else {
        await tx.insert(movement).values({ id: movementId, ...row })
        // A movement first seen in a mail is news for the user; a later mail of it is not.
        await tx.insert(notice).values({ movementId })
      }
      await tx.insert(movementSource).values({
        mailId: mail.mailId,
        movementId,
        templateId: mail.templateId,
        operation: scope.json.seal(op, sourceAad(mail.mailId)),
        eventSeq: seq,
      })
      return { movementId, outcome: matched ? 'linked' : 'created', type: row.type }
    },

    async pendingMailOperations(): Promise<ParsedMail[]> {
      const rows = await tx
        .select({
          mailId: mailParse.mailId,
          templateId: mailParse.templateId,
          operation: mailParse.operation,
        })
        .from(mailParse)
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
 * after accounts change, since "own transfer" depends on them. Returns how many changed type.
 */
export async function reprojectMovements(scope: Scope): Promise<number> {
  const { tx, userId } = scope
  await lockUser(tx, userId, 4202)
  const rows = await tx
    .select({ id: movement.id, type: movement.type, seq: movement.lastEventSeq })
    .from(movement)
    .where(eq(movement.userId, userId))
  const sources = await sourcesOf(
    scope,
    rows.map((r) => r.id),
  )
  let changed = 0
  for (const r of rows) {
    const next = await projection(scope, sources.get(r.id) ?? [], r.seq)
    if (next.type !== r.type) changed++
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
