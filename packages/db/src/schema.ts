import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

const sha = (name: string) => text(name)
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()

/** Every raw file Warren keeps, addressed by the SHA-256 of its bytes. Append-only. */
export const blobFile = pgTable(
  'blob_file',
  {
    sha256: sha('sha256').primaryKey(),
    pathname: text('pathname').notNull().unique(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    storedAt: now('stored_at'),
  },
  (t) => [
    check('blob_file_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('blob_file_bytes_positive', sql`${t.bytes} > 0`),
  ],
)

/** One row per distinct mail (by bytes). Append-only. */
export const inboundMail = pgTable('inbound_mail', {
  sha256: sha('sha256')
    .primaryKey()
    .references(() => blobFile.sha256),
  /** When the mail first reached the receiving provider. */
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  recordedAt: now('recorded_at'),
})

/** One row per delivery by a provider; the same mail can be delivered more than once. */
export const mailDelivery = pgTable(
  'mail_delivery',
  {
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    mailSha256: sha('mail_sha256')
      .notNull()
      .references(() => inboundMail.sha256),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerId] }),
    index('mail_delivery_mail_ix').on(t.mailSha256),
  ],
)

/** One row per verification attempt. A mail's status is its latest row. Append-only. */
export const mailVerdict = pgTable(
  'mail_verdict',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    mailSha256: sha('mail_sha256')
      .notNull()
      .references(() => inboundMail.sha256),
    verdict: text('verdict').notNull(),
    reason: text('reason'),
    detail: text('detail'),
    policyVersion: integer('policy_version').notNull(),
    senderId: text('sender_id'),
    fromAddress: text('from_address'),
    signingDomain: text('signing_domain'),
    selector: text('selector'),
    /** DNS TXT record used, so the mail can be re-checked after the bank rotates its key. */
    keyRecord: text('key_record'),
    signedHeaders: text('signed_headers').array(),
    subject: text('subject'),
    signedDate: timestamp('signed_date', { withTimezone: true }),
    checkedAt: now('checked_at'),
  },
  (t) => [
    check('mail_verdict_kind', sql`${t.verdict} in ('verified','rejected','retry')`),
    check(
      'mail_verdict_shape',
      sql`(${t.verdict} = 'verified') = (${t.senderId} is not null and ${t.signedDate} is not null and ${t.reason} is null)`,
    ),
    index('mail_verdict_mail_ix').on(t.mailSha256, t.id),
  ],
)

/**
 * What a template read out of a verified mail. One row per mail and template set, so a mail
 * is parsed again, as a new row, when the templates change. Append-only.
 */
export const mailParse = pgTable(
  'mail_parse',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    mailSha256: sha('mail_sha256')
      .notNull()
      .references(() => inboundMail.sha256),
    templateSetVersion: integer('template_set_version').notNull(),
    status: text('status').notNull(),
    templateId: text('template_id'),
    templateVersion: integer('template_version'),
    reason: text('reason'),
    operation: jsonb('operation'),
    parsedAt: now('parsed_at'),
  },
  (t) => [
    unique('mail_parse_once_per_set').on(t.mailSha256, t.templateSetVersion),
    check('mail_parse_status', sql`${t.status} in ('parsed','unparsed')`),
    check(
      'mail_parse_shape',
      sql`(${t.status} = 'parsed') = (${t.operation} is not null and ${t.templateId} is not null and ${t.reason} is null)`,
    ),
  ],
)

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

/** The owner's accounts. Written only by the owner role (pnpm ledger:accounts). Append-only. */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    institution: text('institution').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [check('account_kind', sql`${t.kind} in ('asset','liability')`)],
)

/** How an account is recognised in bank data. An identifier belongs to exactly one account. */
export const accountIdentifier = pgTable(
  'account_identifier',
  {
    scheme: text('scheme').notNull(),
    value: text('value').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.scheme, t.value] }),
    check('account_identifier_scheme', sql`${t.scheme} in ('cbu','bank-label')`),
  ],
)

/**
 * The ledger's record of truth. Append-only, and each row carries a hash chained to the row
 * before it, so a rewrite is detectable. Everything else about movements is derived from it.
 */
export const event = pgTable(
  'event',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid('id').notNull().unique(),
    kind: text('kind').notNull(),
    /** The movement this event creates or acts on. */
    subject: uuid('subject').notNull(),
    payload: jsonb('payload').notNull(),
    payloadSha256: bytea('payload_sha256'),
    chainSha256: bytea('chain_sha256'),
    actor: text('actor').notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    check('event_kind', sql`${t.kind} in ('movement','link')`),
    check('event_actor', sql`${t.actor} in ('core','owner','agent','import')`),
    index('event_subject_ix').on(t.subject),
  ],
)

/** Current state of each movement. Derived from events; can be rebuilt from them. */
export const movement = pgTable(
  'movement',
  {
    id: uuid('id').primaryKey(),
    direction: text('direction').notNull(),
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: text('currency').notNull(),
    date: date('date').notNull(),
    time: time('time'),
    /** The owner's account the money left or entered, once a source names it. */
    accountId: text('account_id').references(() => account.id),
    /** Set when the counterparty is one of the owner's accounts. */
    counterAccountId: text('counter_account_id').references(() => account.id),
    counterpartyName: text('counterparty_name'),
    counterpartyAccount: text('counterparty_account'),
    counterpartyTaxId: text('counterparty_tax_id'),
    reference: text('reference'),
    reason: text('reason'),
    type: text('type').notNull(),
    lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('movement_direction', sql`${t.direction} in ('in','out')`),
    check('movement_amount_positive', sql`${t.amount} > 0`),
    check('movement_type', sql`${t.type} in ('own_transfer','unclassified')`),
    check(
      'movement_own_transfer',
      sql`(${t.type} = 'own_transfer') = (${t.counterAccountId} is not null)`,
    ),
    index('movement_match_ix').on(t.date, t.amount, t.currency, t.direction),
  ],
)

/** Which mails describe which movement. A mail belongs to at most one movement. */
export const movementSource = pgTable(
  'movement_source',
  {
    mailSha256: sha('mail_sha256')
      .primaryKey()
      .references(() => inboundMail.sha256),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => movement.id),
    templateId: text('template_id').notNull(),
    operation: jsonb('operation').notNull(),
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
  },
  (t) => [index('movement_source_movement_ix').on(t.movementId, t.eventSeq)],
)

/**
 * A notice owed to the owner about a new movement. Written in the same transaction that
 * creates the movement, so imports and rebuilds never notify. Append-only.
 */
export const notice = pgTable('notice', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  movementId: uuid('movement_id')
    .notNull()
    .unique()
    .references(() => movement.id),
  createdAt: now('created_at'),
})

/** One row per attempt at sending a notice. Append-only. */
export const noticeAttempt = pgTable(
  'notice_attempt',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    noticeId: bigint('notice_id', { mode: 'number' })
      .notNull()
      .references(() => notice.id),
    mode: text('mode').notNull(),
    outcome: text('outcome').notNull(),
    /** The text that was sent, exactly. */
    body: text('body').notNull(),
    /** WhatsApp's id for the message, when the send was accepted. */
    wamid: text('wamid').unique(),
    errorCode: integer('error_code'),
    retryable: boolean('retryable'),
    detail: text('detail'),
    attemptedAt: now('attempted_at'),
  },
  (t) => [
    check('notice_attempt_mode', sql`${t.mode} in ('text','template')`),
    check('notice_attempt_outcome', sql`${t.outcome} in ('sent','failed')`),
    check(
      'notice_attempt_shape',
      sql`(${t.outcome} = 'sent') = (${t.wamid} is not null and ${t.retryable} is null)`,
    ),
    index('notice_attempt_notice_ix').on(t.noticeId, t.id),
  ],
)

/** What WhatsApp later reported about a sent message. Append-only. */
export const noticeStatus = pgTable(
  'notice_status',
  {
    wamid: text('wamid')
      .notNull()
      .references(() => noticeAttempt.wamid),
    status: text('status').notNull(),
    errorCode: integer('error_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.wamid, t.status] }),
    check('notice_status_kind', sql`${t.status} in ('sent','delivered','read','failed')`),
  ],
)
