import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/*
 * Tenancy. Every data table has `user_id`, and its primary key, unique constraints and foreign
 * keys all start with it, so two users can hold the same bank account number or the same mail
 * and neither can learn that the other does (a unique-key conflict is a covert channel that
 * row-level security does not close). Postgres, not app code, keeps users apart: each table
 * has row-level security with policies for the app role, which sets `app.user_id` per
 * transaction (see client.ts). Roles and grants are hand-written SQL (0000, 0002); a test over
 * the catalog fails if a table here is left without them.
 */

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()

export const warrenApp = pgRole('warren_app').existing()
export const warrenEraser = pgRole('warren_eraser').existing()

/** The owning user. Filled from the transaction's user, so an insert outside one fails. */
const userId = () =>
  uuid('user_id')
    .notNull()
    .default(sql`app_user_id()`)
    .references(() => user.id)

const mine = sql`user_id = app_user_id()`

/** Select and insert for the app role. Rows are never updated or deleted by it. */
const tenant = (table: string) => [
  pgPolicy(`${table}_select`, { for: 'select', to: warrenApp, using: mine }),
  pgPolicy(`${table}_insert`, { for: 'insert', to: warrenApp, withCheck: mine }),
]

/** Derived state the app keeps current. */
const tenantWithUpdate = (table: string) => [
  ...tenant(table),
  pgPolicy(`${table}_update`, { for: 'update', to: warrenApp, using: mine, withCheck: mine }),
]

/** For a table that is a setting, not a record: the app may also delete its own rows. */
const tenantWithDelete = (table: string) => [
  ...tenant(table),
  pgPolicy(`${table}_delete`, { for: 'delete', to: warrenApp, using: mine }),
]

/**
 * What the erasure role may remove: only the rows of the user being erased. A table that uses
 * this must also be in `ERASED_TABLES` (tables.ts), have the grants in 0002 and the
 * `forbid_mutation_except_erasure` trigger in 0003: a test compares all four.
 */
const erasable = (table: string) => [
  pgPolicy(`${table}_erase_select`, { for: 'select', to: warrenEraser, using: mine }),
  pgPolicy(`${table}_erase_delete`, { for: 'delete', to: warrenEraser, using: mine }),
]

// ---------------------------------------------------------------------------------------------
// Identity. Matches Better Auth 1.7.25 (`getAuthTables` with email and password enabled): the
// field names are Better Auth's, `account` is renamed `auth_account` because the ledger already
// has an `account`, and ids come from the database (`advanced.database.generateId: false`).
// Only the `warren_auth` role touches these tables (and the rate limiter's, below); `warren_app` has no grants on them.
// ---------------------------------------------------------------------------------------------

export const user = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at').$onUpdate(() => new Date()),
  /** Set when the user was erased. The row stays because every `user_id` points at it. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
})

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at').$onUpdate(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_ix').on(t.userId)],
)

export const authAccount = pgTable(
  'auth_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at').$onUpdate(() => new Date()),
  },
  (t) => [index('auth_account_user_ix').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at').$onUpdate(() => new Date()),
  },
  (t) => [index('verification_identifier_ix').on(t.identifier)],
)

/**
 * Better Auth's rate limiter, kept in the database because per-instance memory is useless on
 * serverless (every request may land on a new instance). One row per client address and path,
 * so it holds addresses, never a user id: erasing a user has nothing to delete here, and Better
 * Auth removes a row once its window has passed. Field names are Better Auth's `rateLimit`
 * model, renamed `rate_limit`; `last_request` is milliseconds since the epoch.
 */
export const rateLimit = pgTable('rate_limit', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
})

// ---------------------------------------------------------------------------------------------
// OAuth: Warren as the authorization server for agents (slice 4). Matches Better Auth 1.7.25's
// `jwt()`, `@better-auth/mcp` and `@better-auth/cimd` plugins (`getAuthTables`; compared with the
// drizzle adapter's own generator). Property names are the plugin's field names, and the keys of
// `authSchema` its model names (`oauthClient`, ...). Ids are uuids from the database, except
// that the plugin may mint a deterministic uuid for a replay tombstone. `client_id` is the
// client's own text (for a metadata-document client, its https URL), not a uuid. Only
// `warren_auth` touches these tables (0010).
// ---------------------------------------------------------------------------------------------

/** The signing keys of the JWT plugin; the private half is encrypted with the auth secret. */
export const jwks = pgTable('jwks', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: now('created_at'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
})

const optionalTime = (name: string) => timestamp(name, { withTimezone: true })

/** An OAuth client. One per client-id URL, made from its fetched metadata document. */
export const oauthClient = pgTable(
  'oauth_client',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: optionalTime('created_at'),
    updatedAt: optionalTime('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('oauth_client_user_ix').on(t.userId)],
)

/** A protected resource: the MCP endpoint, seeded when the server starts. */
export const oauthResource = pgTable('oauth_resource', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: optionalTime('created_at'),
  updatedAt: optionalTime('updated_at'),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
})

export const oauthClientResource = pgTable(
  'oauth_client_resource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: optionalTime('created_at'),
  },
  (t) => [
    unique('oauth_client_resource_unique').on(t.clientId, t.resourceId),
    index('oauth_client_resource_client_ix').on(t.clientId),
    index('oauth_client_resource_resource_ix').on(t.resourceId),
  ],
)

export const oauthRefreshToken = pgTable(
  'oauth_refresh_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: optionalTime('expires_at'),
    createdAt: optionalTime('created_at'),
    revoked: optionalTime('revoked'),
    rotatedAt: optionalTime('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: optionalTime('rotation_replay_expires_at'),
    authTime: optionalTime('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_refresh_token_client_ix').on(t.clientId),
    index('oauth_refresh_token_session_ix').on(t.sessionId),
    index('oauth_refresh_token_user_ix').on(t.userId),
    index('oauth_refresh_token_code_ix').on(t.authorizationCodeId),
  ],
)

export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: uuid('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: optionalTime('expires_at'),
    createdAt: optionalTime('created_at'),
    revoked: optionalTime('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauth_access_token_client_ix').on(t.clientId),
    index('oauth_access_token_session_ix').on(t.sessionId),
    index('oauth_access_token_user_ix').on(t.userId),
    index('oauth_access_token_code_ix').on(t.authorizationCodeId),
    index('oauth_access_token_refresh_ix').on(t.refreshId),
  ],
)

/** What a user agreed to, once per client. */
export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: optionalTime('created_at'),
    updatedAt: optionalTime('updated_at'),
  },
  (t) => [
    index('oauth_consent_client_ix').on(t.clientId),
    index('oauth_consent_user_ix').on(t.userId),
  ],
)

/** Single-use tombstones for client assertions and DPoP proofs: the id is a digest. No user. */
export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: uuid('id').primaryKey().defaultRandom(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

// ---------------------------------------------------------------------------------------------
// Keys, routing and erasure
// ---------------------------------------------------------------------------------------------

/**
 * A user's data key, wrapped by the master key. The one mutable table of personal data:
 * deleting a row here is what makes that user's sealed columns and files unreadable.
 */
export const userKey = pgTable(
  'user_key',
  {
    userId: userId(),
    wrappedKey: bytea('wrapped_key').notNull(),
    /** Which master key wrapped it, so the master key can rotate without touching sealed rows. */
    wrapVersion: integer('wrap_version').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [primaryKey({ columns: [t.userId] }), ...tenant('user_key'), ...erasable('user_key')],
).enableRLS()

/**
 * An address that forwards bank mail to a user. An address belongs to one person, so it is
 * unique across users; the operator registers them (slice 6 automates this), never sign-up,
 * so nobody can claim a victim's address to receive their mail.
 */
export const mailbox = pgTable(
  'mailbox',
  {
    userId: userId(),
    address: text('address').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.address] }),
    // The one key that does not start with user_id, on purpose: see the comment above.
    unique('mailbox_address_unique').on(t.address),
    check('mailbox_address_lower', sql`${t.address} = lower(${t.address})`),
    ...tenant('mailbox'),
    ...erasable('mailbox'),
  ],
).enableRLS()

/**
 * A user's own address for forwarded bank mail: `<token>@<inbound domain>`. The token is
 * unguessable (core `newInboundToken`) and unique across users, because mail arrives knowing
 * only the address. Like `mailbox_address_unique`, that one key does not start with `user_id`
 * (`EXEMPT_KEYS`). A user has at most one active address: the partial index below starts with
 * `user_id` and is also what makes get-or-create race-safe. Revoking (setting `revoked_at`) is
 * the only update, so the app role gets a column grant on it alone (0012), like a setting.
 * Routing only picks whose ledger checks a mail; rule 4 still needs the signed To in `mailbox`.
 */
export const inboundAddress = pgTable(
  'inbound_address',
  {
    userId: userId(),
    token: text('token').notNull(),
    createdAt: now('created_at'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.token] }),
    unique('inbound_address_token_unique').on(t.token),
    check('inbound_address_token_format', sql`${t.token} ~ '^u-[a-z2-7]{22}$'`),
    uniqueIndex('inbound_address_active_ix').on(t.userId).where(sql`${t.revokedAt} is null`),
    ...tenantWithUpdate('inbound_address'),
    ...erasable('inbound_address'),
  ],
).enableRLS()

/**
 * A delivery no user claimed. Holds no content, only that something arrived, so the provider
 * is answered with success and does not retry. The only table without `user_id`. Append-only.
 */
export const unroutedDelivery = pgTable(
  'unrouted_delivery',
  {
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerId] })],
)

/** Written when a user is erased: when, and the head of their hash chain at that moment. Append-only. */
export const erasure = pgTable(
  'erasure',
  {
    userId: userId(),
    chainHead: bytea('chain_head'),
    erasedAt: now('erased_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId] }),
    ...tenant('erasure'),
    pgPolicy('erasure_erase_select', { for: 'select', to: warrenEraser, using: mine }),
    pgPolicy('erasure_erase_insert', { for: 'insert', to: warrenEraser, withCheck: mine }),
  ],
).enableRLS()

// ---------------------------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------------------------

/**
 * Every raw file a user has, addressed by the mail's keyed identity. Append-only. The file is
 * sealed; `bytes` is the length of the mail itself.
 */
export const blobFile = pgTable(
  'blob_file',
  {
    userId: userId(),
    mailId: text('mail_id').notNull(),
    pathname: text('pathname').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    storedAt: now('stored_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mailId] }),
    unique('blob_file_pathname_unique').on(t.userId, t.pathname),
    check('blob_file_mail_id_hex', sql`${t.mailId} ~ '^[0-9a-f]{64}$'`),
    check('blob_file_bytes_positive', sql`${t.bytes} > 0`),
    ...tenant('blob_file'),
  ],
).enableRLS()

/** One row per distinct mail of a user. Append-only. */
export const inboundMail = pgTable(
  'inbound_mail',
  {
    userId: userId(),
    mailId: text('mail_id').notNull(),
    /** When the mail first reached the receiving provider. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mailId] }),
    foreignKey({
      name: 'inbound_mail_blob_fk',
      columns: [t.userId, t.mailId],
      foreignColumns: [blobFile.userId, blobFile.mailId],
    }),
    ...tenant('inbound_mail'),
  ],
).enableRLS()

/** One row per delivery by a provider; the same mail can be delivered more than once. */
export const mailDelivery = pgTable(
  'mail_delivery',
  {
    userId: userId(),
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    mailId: text('mail_id').notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider, t.providerId] }),
    foreignKey({
      name: 'mail_delivery_mail_fk',
      columns: [t.userId, t.mailId],
      foreignColumns: [inboundMail.userId, inboundMail.mailId],
    }),
    index('mail_delivery_mail_ix').on(t.userId, t.mailId),
    ...tenant('mail_delivery'),
  ],
).enableRLS()

/**
 * One row per verification attempt. A mail's status is its latest row. Append-only.
 * `subject` and `detail` are sealed.
 */
export const mailVerdict = pgTable(
  'mail_verdict',
  {
    userId: userId(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    mailId: text('mail_id').notNull(),
    verdict: text('verdict').notNull(),
    reason: text('reason'),
    detail: bytea('detail'),
    policyVersion: integer('policy_version').notNull(),
    senderId: text('sender_id'),
    /** The bank's address, clear, only when the sender matched the allow-list; otherwise null and the address is sealed in `detail`. */
    fromAddress: text('from_address'),
    signingDomain: text('signing_domain'),
    selector: text('selector'),
    /** DNS TXT record used, so the mail can be re-checked after the bank rotates its key. */
    keyRecord: text('key_record'),
    signedHeaders: text('signed_headers').array(),
    subject: bytea('subject'),
    signedDate: timestamp('signed_date', { withTimezone: true }),
    checkedAt: now('checked_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: 'mail_verdict_mail_fk',
      columns: [t.userId, t.mailId],
      foreignColumns: [inboundMail.userId, inboundMail.mailId],
    }),
    check('mail_verdict_kind', sql`${t.verdict} in ('verified','rejected','retry')`),
    check(
      'mail_verdict_shape',
      sql`(${t.verdict} = 'verified') = (${t.senderId} is not null and ${t.signedDate} is not null and ${t.reason} is null)`,
    ),
    index('mail_verdict_mail_ix').on(t.userId, t.mailId, t.id),
    ...tenant('mail_verdict'),
  ],
).enableRLS()

/**
 * What a template read out of a verified mail. One row per mail and template set, so a mail
 * is parsed again, as a new row, when the templates change. Append-only. `operation` is sealed.
 */
export const mailParse = pgTable(
  'mail_parse',
  {
    userId: userId(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    mailId: text('mail_id').notNull(),
    templateSetVersion: integer('template_set_version').notNull(),
    status: text('status').notNull(),
    templateId: text('template_id'),
    templateVersion: integer('template_version'),
    reason: text('reason'),
    operation: bytea('operation'),
    parsedAt: now('parsed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: 'mail_parse_mail_fk',
      columns: [t.userId, t.mailId],
      foreignColumns: [inboundMail.userId, inboundMail.mailId],
    }),
    unique('mail_parse_once_per_set').on(t.userId, t.mailId, t.templateSetVersion),
    check('mail_parse_status', sql`${t.status} in ('parsed','unparsed')`),
    check(
      'mail_parse_shape',
      sql`(${t.status} = 'parsed') = (${t.operation} is not null and ${t.templateId} is not null and ${t.reason} is null)`,
    ),
    ...tenant('mail_parse'),
  ],
).enableRLS()

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

/**
 * A user's accounts. Written only by the operator (pnpm ledger:accounts). Append-only, except
 * that erasing the user deletes them: `name` is the user's own and sits in clear.
 */
export const account = pgTable(
  'account',
  {
    userId: userId(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    institution: text('institution').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check('account_kind', sql`${t.kind} in ('asset','liability')`),
    ...tenant('account'),
    ...erasable('account'),
  ],
).enableRLS()

/**
 * How an account is recognised in bank data (a CBU, a bank's label). An identifier belongs to
 * exactly one account. Append-only, except that erasing the user deletes it: `value` is the
 * user's own and sits in clear, because it is part of the key.
 */
export const accountIdentifier = pgTable(
  'account_identifier',
  {
    userId: userId(),
    scheme: text('scheme').notNull(),
    value: text('value').notNull(),
    accountId: text('account_id').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scheme, t.value] }),
    foreignKey({
      name: 'account_identifier_account_fk',
      columns: [t.userId, t.accountId],
      foreignColumns: [account.userId, account.id],
    }),
    check('account_identifier_scheme', sql`${t.scheme} in ('cbu','bank-label','card-last-four')`),
    ...tenant('account_identifier'),
    ...erasable('account_identifier'),
  ],
).enableRLS()

/**
 * The ledger's record of truth. Append-only, and each row carries a hash chained to the row
 * before it for the same user, so a rewrite is detectable. The hash covers the sealed
 * `payload`, so the chain still verifies after the user's key is destroyed.
 */
export const event = pgTable(
  'event',
  {
    userId: userId(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    id: uuid('id').notNull(),
    kind: text('kind').notNull(),
    /** The movement this event creates or acts on. */
    subject: uuid('subject').notNull(),
    /** Sealed JSON. */
    payload: bytea('payload').notNull(),
    payloadSha256: bytea('payload_sha256'),
    chainSha256: bytea('chain_sha256'),
    actor: text('actor').notNull(),
    recordedAt: now('recorded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.seq] }),
    unique('event_id_unique').on(t.userId, t.id),
    check('event_kind', sql`${t.kind} in ('movement','link')`),
    check('event_actor', sql`${t.actor} in ('core','owner','agent','import')`),
    index('event_subject_ix').on(t.userId, t.subject),
    ...tenant('event'),
    // The erasure role reads only the chain head to write the tombstone.
    pgPolicy('event_erase_select', { for: 'select', to: warrenEraser, using: mine }),
  ],
).enableRLS()

/** Current state of each movement. Derived from events; can be rebuilt. Erased with the user. */
export const movement = pgTable(
  'movement',
  {
    userId: userId(),
    id: uuid('id').notNull(),
    direction: text('direction').notNull(),
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: text('currency').notNull(),
    date: date('date').notNull(),
    time: time('time'),
    /** The user's account the money left or entered, once a source names it. */
    accountId: text('account_id'),
    /** Set when the counterparty is one of the user's accounts. */
    counterAccountId: text('counter_account_id'),
    /** For a card purchase, the merchant. */
    counterpartyName: text('counterparty_name'),
    counterpartyAccount: text('counterparty_account'),
    counterpartyTaxId: text('counterparty_tax_id'),
    reference: text('reference'),
    reason: text('reason'),
    /** The card's last four digits, for a card purchase. */
    cardLastFour: text('card_last_four'),
    type: text('type').notNull(),
    lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: 'movement_account_fk',
      columns: [t.userId, t.accountId],
      foreignColumns: [account.userId, account.id],
    }),
    foreignKey({
      name: 'movement_counter_account_fk',
      columns: [t.userId, t.counterAccountId],
      foreignColumns: [account.userId, account.id],
    }),
    check('movement_direction', sql`${t.direction} in ('in','out')`),
    check('movement_amount_positive', sql`${t.amount} > 0`),
    check('movement_type', sql`${t.type} in ('own_transfer','unclassified','card_purchase')`),
    check(
      'movement_own_transfer',
      sql`(${t.type} = 'own_transfer') = (${t.counterAccountId} is not null)`,
    ),
    index('movement_match_ix').on(t.userId, t.date, t.amount, t.currency, t.direction),
    ...tenantWithUpdate('movement'),
    ...erasable('movement'),
  ],
).enableRLS()

/** Which mails describe which movement. A mail belongs to at most one movement. `operation` is sealed. */
export const movementSource = pgTable(
  'movement_source',
  {
    userId: userId(),
    mailId: text('mail_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    templateId: text('template_id').notNull(),
    operation: bytea('operation').notNull(),
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mailId] }),
    foreignKey({
      name: 'movement_source_mail_fk',
      columns: [t.userId, t.mailId],
      foreignColumns: [inboundMail.userId, inboundMail.mailId],
    }),
    foreignKey({
      name: 'movement_source_movement_fk',
      columns: [t.userId, t.movementId],
      foreignColumns: [movement.userId, movement.id],
    }),
    index('movement_source_movement_ix').on(t.userId, t.movementId, t.eventSeq),
    ...tenant('movement_source'),
    ...erasable('movement_source'),
  ],
).enableRLS()

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------

/**
 * A notice owed to a user about a new movement. Written in the same transaction that creates
 * the movement, so imports and rebuilds never notify. Append-only, except that erasing the
 * user deletes it (see 0003_append_only.sql).
 */
export const notice = pgTable(
  'notice',
  {
    userId: userId(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    movementId: uuid('movement_id').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique('notice_movement_unique').on(t.userId, t.movementId),
    foreignKey({
      name: 'notice_movement_fk',
      columns: [t.userId, t.movementId],
      foreignColumns: [movement.userId, movement.id],
    }),
    ...tenant('notice'),
    ...erasable('notice'),
  ],
).enableRLS()

/**
 * A browser that may be pushed to. A setting, not a record, so it is mutable like `user_key`:
 * `warren_app` may delete its own rows (turning notifications off, or the push service saying
 * the subscription is gone) and erasure deletes them. `endpoint` is a bearer URL and, with the
 * two keys, is sealed. `endpoint_key` finds a subscription without opening it, so subscribing
 * twice from one browser is one row.
 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    userId: userId(),
    id: uuid('id').notNull().defaultRandom(),
    endpointKey: text('endpoint_key').notNull(),
    endpoint: bytea('endpoint').notNull(),
    p256dh: bytea('p256dh').notNull(),
    auth: bytea('auth').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique('push_subscription_endpoint_unique').on(t.userId, t.endpointKey),
    ...tenantWithDelete('push_subscription'),
    ...erasable('push_subscription'),
  ],
).enableRLS()

/**
 * A user's financial profile, one row per save: a correction is a new version and the highest
 * wins. `data` is sealed JSON (income, goals, obligations, risk limits). Append-only, except
 * that erasing the user deletes it: old goals have no ledger value worth keeping.
 */
export const profile = pgTable(
  'profile',
  {
    userId: userId(),
    version: integer('version').notNull(),
    data: bytea('data').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [
    // Two saves at the same moment pick the same next version; the second one fails here.
    primaryKey({ columns: [t.userId, t.version] }),
    check('profile_version', sql`${t.version} >= 1`),
    ...tenant('profile'),
    ...erasable('profile'),
  ],
).enableRLS()

/**
 * Google's confirmation mail, captured when the user adds their Warren address as a forwarding
 * address in Gmail. `data` is sealed JSON `{ address, url }` (the Gmail asking, and Google's
 * confirm link). `address_hash` is the sha256 (hex) of the lowercased address, so the database
 * can check a mailbox claim (`claim_mailbox`, 0013) without opening anything. Append-only,
 * except that erasing the user deletes it.
 */
export const forwardingConfirmation = pgTable(
  'forwarding_confirmation',
  {
    userId: userId(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    addressHash: text('address_hash').notNull(),
    data: bytea('data').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    check('forwarding_confirmation_hash', sql`${t.addressHash} ~ '^[0-9a-f]{64}$'`),
    index('forwarding_confirmation_ix').on(t.userId, t.addressHash, t.receivedAt),
    ...tenant('forwarding_confirmation'),
    ...erasable('forwarding_confirmation'),
  ],
).enableRLS()

/**
 * One row per attempt at sending a notice. Append-only. `body` and `detail` are sealed.
 * `notice_id` has no foreign key: erasing a user deletes their notices but must leave
 * this row, which is append-only, standing as ciphertext.
 */
export const noticeAttempt = pgTable(
  'notice_attempt',
  {
    userId: userId(),
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    noticeId: bigint('notice_id', { mode: 'number' }).notNull(),
    mode: text('mode').notNull(),
    outcome: text('outcome').notNull(),
    /** The text that was sent, exactly. Sealed. */
    body: bytea('body').notNull(),
    /** Legacy: the former WhatsApp notifier's message id. Old rows only; nothing writes it. */
    wamid: text('wamid'),
    errorCode: integer('error_code'),
    retryable: boolean('retryable'),
    detail: bytea('detail'),
    /** Push only: the subscription it went to. No foreign key: the row outlives the subscription. */
    subscriptionId: uuid('subscription_id'),
    /** Push only: the push service's HTTP status, when it answered. */
    statusCode: integer('status_code'),
    attemptedAt: now('attempted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique('notice_attempt_wamid_unique').on(t.userId, t.wamid),
    // `text` and `template` are the former WhatsApp notifier's: old rows only, nothing writes them.
    check('notice_attempt_mode', sql`${t.mode} in ('text','template','push')`),
    check('notice_attempt_outcome', sql`${t.outcome} in ('sent','failed')`),
    // A sent attempt names the WhatsApp message or the subscription it reached, and has no
    // `retryable`; a failed one has `retryable`. Push attempts, and only they, name a subscription.
    check(
      'notice_attempt_shape',
      sql`(${t.outcome} = 'sent') = ((${t.wamid} is not null or ${t.subscriptionId} is not null) and ${t.retryable} is null)`,
    ),
    check('notice_attempt_push', sql`(${t.mode} = 'push') = (${t.subscriptionId} is not null)`),
    index('notice_attempt_notice_ix').on(t.userId, t.noticeId, t.id),
    ...tenant('notice_attempt'),
  ],
).enableRLS()
