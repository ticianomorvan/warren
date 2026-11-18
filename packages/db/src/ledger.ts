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
import type { Db } from './client'
import {
  account,
  accountIdentifier,
  event,
  mailParse,
  movement,
  movementSource,
  notice,
} from './schema'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

const direction = (op: BankOperation) => (op.kind === 'transfer_in' ? 'in' : 'out')

async function accountFor(db: Executor, scheme: 'cbu' | 'bank-label', value: string | null) {
  if (value === null) return null
  const rows = await db
    .select({ accountId: accountIdentifier.accountId })
    .from(accountIdentifier)
    .where(and(eq(accountIdentifier.scheme, scheme), eq(accountIdentifier.value, value)))
    .limit(1)
  return rows[0]?.accountId ?? null
}

/** The derived row for a movement: its sources merged, and its accounts resolved. */
async function projection(db: Executor, sources: MovementSource[], lastEventSeq: number) {
  const op = mergeSources(sources)
  const counterAccountId = await accountFor(db, 'cbu', op.counterparty.account)
  return {
    direction: direction(op),
    amount: op.amount,
    currency: op.currency,
    date: op.date,
    time: op.time,
    accountId: await accountFor(db, 'bank-label', op.ownAccount),
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
  db: Executor,
  movementIds: string[],
): Promise<Map<string, MovementSource[]>> {
  const out = new Map<string, MovementSource[]>()
  if (movementIds.length === 0) return out
  const rows = await db
    .select()
    .from(movementSource)
    .where(inArray(movementSource.movementId, movementIds))
    .orderBy(asc(movementSource.eventSeq))
  for (const r of rows) {
    const list = out.get(r.movementId) ?? []
    list.push({
      mailSha256: r.mailSha256,
      templateId: r.templateId,
      operation: r.operation as BankOperation,
    })
    out.set(r.movementId, list)
  }
  return out
}

export function createLedger(db: Db): Ledger {
  return {
    async recordMailOperation(mail: ParsedMail): Promise<RecordOutcome> {
      return db.transaction(async (tx) => {
        // One recording at a time, so two mails of one operation cannot both create a movement.
        await tx.execute(sql`select pg_advisory_xact_lock(4202)`)

        const existing = await tx
          .select({ movementId: movementSource.movementId, type: movement.type })
          .from(movementSource)
          .innerJoin(movement, eq(movement.id, movementSource.movementId))
          .where(eq(movementSource.mailSha256, mail.mailSha256))
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
          tx,
          rows.map((r) => r.id),
        )
        const candidates: Candidate[] = rows.map((r) => ({
          movementId: r.id,
          sources: known.get(r.id) ?? [],
        }))
        const matched = matchMovement(mail, candidates)

        const movementId = matched ?? eventId('movement', mail.mailSha256)
        const source: MovementSource = {
          mailSha256: mail.mailSha256,
          templateId: mail.templateId,
          operation: op,
        }
        const inserted = await tx
          .insert(event)
          .values({
            id: matched ? eventId('link', mail.mailSha256) : movementId,
            kind: matched ? 'link' : 'movement',
            subject: movementId,
            payload: { source: 'mail', ...source },
            actor: 'core',
          })
          .returning({ seq: event.seq })
        const seq = inserted[0]?.seq
        if (seq === undefined) throw new Error('event insert returned no row')

        const sources = [...(known.get(movementId) ?? []), source]
        const row = await projection(tx, sources, seq)
        if (matched) await tx.update(movement).set(row).where(eq(movement.id, movementId))
        else {
          await tx.insert(movement).values({ id: movementId, ...row })
          // A movement first seen in a mail is news for the owner; a later mail of it is not.
          await tx.insert(notice).values({ movementId })
        }
        await tx.insert(movementSource).values({
          mailSha256: mail.mailSha256,
          movementId,
          templateId: mail.templateId,
          operation: op,
          eventSeq: seq,
        })
        return { movementId, outcome: matched ? 'linked' : 'created', type: row.type }
      })
    },

    async pendingMailOperations(): Promise<ParsedMail[]> {
      const rows = await db
        .select({
          mailSha256: mailParse.mailSha256,
          templateId: mailParse.templateId,
          operation: mailParse.operation,
        })
        .from(mailParse)
        .leftJoin(movementSource, eq(movementSource.mailSha256, mailParse.mailSha256))
        .where(
          and(
            eq(mailParse.status, 'parsed'),
            eq(mailParse.templateSetVersion, TEMPLATE_SET_VERSION),
            isNull(movementSource.mailSha256),
          ),
        )
        .orderBy(asc(mailParse.id))
      return rows.flatMap((r) =>
        r.templateId && r.operation
          ? [
              {
                mailSha256: r.mailSha256,
                templateId: r.templateId,
                operation: r.operation as BankOperation,
              },
            ]
          : [],
      )
    },
  }
}

/** Adds accounts and identifiers that are not there yet. Owner role only. */
export async function seedAccounts(db: Db, seeds: readonly AccountSeed[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const { identifiers, ...row } of seeds) {
      await tx.insert(account).values(row).onConflictDoNothing()
      for (const identifier of identifiers) {
        await tx
          .insert(accountIdentifier)
          .values({ ...identifier, accountId: row.id })
          .onConflictDoNothing()
      }
    }
  })
}

/**
 * Recomputes every movement row from its sources and the current accounts. Needed after
 * accounts change, since "own transfer" depends on them. Returns how many rows changed type.
 */
export async function reprojectMovements(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4202)`)
    const rows = await tx
      .select({ id: movement.id, type: movement.type, seq: movement.lastEventSeq })
      .from(movement)
    const sources = await sourcesOf(
      tx,
      rows.map((r) => r.id),
    )
    let changed = 0
    for (const r of rows) {
      const next = await projection(tx, sources.get(r.id) ?? [], r.seq)
      if (next.type !== r.type) changed++
      await tx.update(movement).set(next).where(eq(movement.id, r.id))
    }
    return changed
  })
}

export type MovementRow = typeof movement.$inferSelect & { sources: number }

/** Latest movements, newest first. */
export async function recentMovements(db: Db, limit = 20): Promise<MovementRow[]> {
  const counts = db
    .select({ id: movementSource.movementId, n: sql<number>`count(*)::int`.as('n') })
    .from(movementSource)
    .groupBy(movementSource.movementId)
    .as('counts')
  const rows = await db
    .select({ movement, sources: counts.n })
    .from(movement)
    .innerJoin(counts, eq(counts.id, movement.id))
    .orderBy(sql`${movement.date} desc, ${movement.lastEventSeq} desc`)
    .limit(limit)
  return rows.map((r) => ({ ...r.movement, sources: r.sources }))
}
