import { getTableName } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import {
  account,
  accountIdentifier,
  authAccount,
  blobFile,
  erasure,
  event,
  inboundAddress,
  inboundMail,
  jwks,
  mailbox,
  mailDelivery,
  mailParse,
  mailVerdict,
  movement,
  movementSource,
  notice,
  noticeAttempt,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  profile,
  pushSubscription,
  rateLimit,
  session,
  unroutedDelivery,
  user,
  userKey,
  verification,
} from './schema'

/*
 * Every table, tagged once. Three things read this and nothing keeps a second list: the
 * tenancy check (which tables hold a user's rows), `eraseUser` (what it deletes, and in which
 * order), and the tests over the catalog (the eraser's grants, policies and triggers must say
 * exactly what `ERASED_TABLES` says; a table in `schema.ts` that is in none of the lists fails).
 */

/** Better Auth's tables. Only `warren_auth` touches them; `warren_app` has no grant on them. */
export const AUTH_TABLES: readonly PgTable[] = [
  user,
  session,
  authAccount,
  verification,
  rateLimit,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
]

/**
 * Auth tables with no user in them: client addresses and counters, the signing keys, the OAuth
 * clients (made from a public metadata document, owned by nobody), the protected resource and
 * its links, and the single-use tombstones (a digest). Erasure has nothing to do.
 */
export const AUTH_UNBOUND_TABLES: readonly PgTable[] = [
  rateLimit,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
]

/**
 * What erasing a user removes from Better Auth's side, as `warren_auth` (`eraseAuthUser`): their
 * sessions, their credentials, and any pending verification for their email. The `user` row
 * stays, because every `user_id` points at it: its personal columns are scrubbed instead
 * (`USER_ROW`). `rate_limit` holds client addresses and no user id, so erasure has nothing to do
 * there (`AUTH_UNBOUND_TABLES`). `warren_auth` may delete exactly these and `rate_limit` (Better
 * Auth prunes it), and never a `user` row: a test compares.
 */
export const AUTH_ERASED_TABLES: readonly PgTable[] = [
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  session,
  authAccount,
  verification,
]

/** The `user` row after erasure: personal columns scrubbed, the rest reviewed as non-personal. */
export const USER_ROW = {
  scrubbed: ['name', 'email', 'image'],
  clear: ['id', 'emailVerified', 'createdAt', 'updatedAt', 'erasedAt'],
} as const

/** Without `user_id`, on purpose: content-free notes of mail nobody claimed. */
export const EXEMPT_TABLES: readonly PgTable[] = [unroutedDelivery]

/**
 * Tenant tables that erasing a user deletes, children before parents (movements point at
 * accounts, sources and notices at movements, identifiers at accounts). Each holds personal
 * data in clear, or is derived from data that is: erasure deletes it. Every one has a
 * `user_id` column.
 */
export const ERASED_TABLES = [
  notice,
  movementSource,
  movement,
  accountIdentifier,
  account,
  mailbox,
  inboundAddress,
  pushSubscription,
  profile,
  userKey,
] as const

/**
 * Tenant tables `warren_app` may update (a grant and an update policy): derived state that can
 * be rebuilt from the append-only tables, and `inbound_address`, whose only update is revoking (a
 * column grant on `revoked_at`, 0012). Every other tenant table is insert-only for it.
 */
export const MUTABLE_TABLES = [movement, inboundAddress] as const

/**
 * Tenant tables `warren_app` may delete from (a grant and a delete policy): settings, not
 * records. Every other tenant table is insert-only for it.
 */
export const DELETABLE_TABLES = [pushSubscription] as const

type Kept<T extends PgTable> = {
  table: T
  /** Ciphertext: gone for good once the user's key is. */
  sealed: readonly (keyof T['$inferSelect'])[]
  /**
   * Every other column, in clear. Reviewed as non-personal: keys, ids, kinds, status codes,
   * hashes and times. A new column is a decision, so it fails the test until it is listed here.
   */
  clear: readonly (keyof T['$inferSelect'])[]
}
const kept = <T extends PgTable>(entry: Kept<T>) => entry as unknown as Kept<PgTable>

/**
 * Tenant tables that stay after erasure, because they are append-only: they must hold only
 * ciphertext, or columns that say nothing about a person.
 */
export const KEPT_TABLES: readonly Kept<PgTable>[] = [
  kept({
    table: event,
    sealed: ['payload'],
    clear: [
      'userId',
      'seq',
      'id',
      'kind',
      'subject',
      'payloadSha256',
      'chainSha256',
      'actor',
      'recordedAt',
    ],
  }),
  kept({
    table: mailParse,
    sealed: ['operation'],
    clear: [
      'userId',
      'id',
      'mailId',
      'templateSetVersion',
      'status',
      'templateId',
      'templateVersion',
      'reason',
      'parsedAt',
    ],
  }),
  kept({
    table: mailVerdict,
    sealed: ['subject', 'detail'],
    clear: [
      'userId',
      'id',
      'mailId',
      'verdict',
      'reason',
      'policyVersion',
      'senderId',
      // Only an allow-listed sender's address (the bank's, never a person's): intake stores it
      // clear when the sender matched (verified, or rejected after the match) and otherwise
      // seals it into `detail`. A forwarded-by-hand mail's From is the user's own address.
      'fromAddress',
      'signingDomain',
      'selector',
      'keyRecord',
      'signedHeaders',
      'signedDate',
      'checkedAt',
    ],
  }),
  kept({
    table: inboundMail,
    sealed: [],
    clear: ['userId', 'mailId', 'receivedAt', 'recordedAt'],
  }),
  kept({
    table: blobFile,
    sealed: [],
    clear: ['userId', 'mailId', 'pathname', 'mime', 'bytes', 'storedAt'],
  }),
  kept({
    table: mailDelivery,
    sealed: [],
    clear: ['userId', 'provider', 'providerId', 'mailId', 'recordedAt'],
  }),
  kept({
    table: noticeAttempt,
    sealed: ['body', 'detail'],
    clear: [
      'userId',
      'id',
      'noticeId',
      'mode',
      'outcome',
      'wamid',
      'errorCode',
      'retryable',
      'subscriptionId',
      'statusCode',
      'attemptedAt',
    ],
  }),
  // The tombstone: when, and the head of the chain.
  kept({ table: erasure, sealed: [], clear: ['userId', 'chainHead', 'erasedAt'] }),
]

export const tableNames = (tables: readonly PgTable[]): string[] => tables.map(getTableName)
