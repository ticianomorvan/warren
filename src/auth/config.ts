import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource as fetchOverNode } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { PostgresJSDialect } from 'kysely-postgres-js'
import type { Sql } from '../core/db'
import { clientIdAllowed } from '../mcp/clients'

/** What a token may be used for. `offline_access` is the refresh token. */
export const SCOPES = ['ledger:read', 'ledger:write', 'offline_access'] as const

/** An access token lives 15 minutes; the refresh token renews it. */
export const ACCESS_TOKEN_SECONDS = 15 * 60

/** The sign-in session only exists to finish consent. */
export const SESSION_SECONDS = 60 * 60

/** The path better-auth runs Google's callback under: the only one that may make a user. */
const GOOGLE_CALLBACK = '/callback/:id'

/** The MCP endpoint, which is also the audience of every access token (RFC 8707). */
export const mcpUrl = (publicUrl: string) => new URL('/mcp', publicUrl).href

/** Every better-auth table is `auth_*`: its `account` is not our `account`. Columns keep its own names. */
export const AUTH_TABLES = {
  user: 'auth_user',
  session: 'auth_session',
  account: 'auth_account',
  verification: 'auth_verification',
  jwks: 'auth_jwks',
  oauthClient: 'auth_oauth_client',
  oauthResource: 'auth_oauth_resource',
  oauthClientResource: 'auth_oauth_client_resource',
  oauthClientAssertion: 'auth_oauth_client_assertion',
  oauthRefreshToken: 'auth_oauth_refresh_token',
  oauthAccessToken: 'auth_oauth_access_token',
  oauthConsent: 'auth_oauth_consent',
} as const

export interface AuthSettings {
  /** Our own postgres.js connection: better-auth runs on it through Kysely, no second pool. */
  sql: Sql
  /** `https://heywarren.app`: the issuer, and the host the OAuth routes answer on. */
  publicUrl: string
  secret: string
  /** The OAuth client of "Continuar con Google". */
  google: { clientId: string; clientSecret: string }
  /** How a client's metadata document is fetched. A test passes a fake; the default pins the DNS answer. */
  fetchClientMetadataResource?: ClientMetadataResourceFetch
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void
}

/**
 * The OAuth 2.1 authorization server for Warren's MCP endpoint: better-auth on our own database, any agent: a
 * metadata document (CIMD) on a public https host, or a client that registers itself (DCR). "Continuar con Google" is the only way in, open to anyone with a Google account:
 * no password, no email sign-up. The first Google sign-in of a person makes their `auth_user` and, in the `after` hook, their
 * `account` row; any other way a user could be created is refused in the `before` hook.
 */
export function createAuth(s: AuthSettings) {
  const instance = betterAuth({
    appName: 'Warren',
    baseURL: s.publicUrl,
    secret: s.secret,
    database: { dialect: new PostgresJSDialect({ postgres: s.sql as never }), type: 'postgres' },
    // The migrations are ours (`002_auth.sql`); better-auth never alters the schema.
    user: {
      modelName: AUTH_TABLES.user,
      additionalFields: {
        // The person: our `account` row. Set when the user is made, never by a client.
        warrenAccountId: {
          type: 'number',
          bigint: true,
          required: false,
          unique: true,
          input: false,
          fieldName: 'warren_account_id',
        },
      },
    },
    session: {
      modelName: AUTH_TABLES.session,
      expiresIn: SESSION_SECONDS,
      disableSessionRefresh: true,
    },
    // Google's tokens are never kept (below), so a later sign-in has nothing to refresh.
    account: { modelName: AUTH_TABLES.account, updateAccountOnSignIn: false },
    socialProviders: {
      google: { clientId: s.google.clientId, clientSecret: s.google.clientSecret },
    },
    databaseHooks: {
      user: {
        create: {
          // A user exists only when Google's callback made it: not by email, not by any other route a plugin may add.
          before: async (_user, ctx) => (ctx?.path === GOOGLE_CALLBACK ? undefined : false),
          // The person: one `account` row, linked to the user. Runs once, when the user is first made.
          after: async (user) => {
            await s.sql.begin(async (tx) => {
              const [row] = await tx<{ id: number }[]>`
                INSERT INTO account DEFAULT VALUES RETURNING id::int AS id`
              await tx`UPDATE auth_user SET warren_account_id = ${(row as { id: number }).id} WHERE id = ${user.id}::uuid`
            })
          },
        },
      },
      account: {
        create: {
          // Warren never holds access to anything of Google's: only that this user signed in with this Google account.
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null, scope: null },
          }),
        },
      },
    },
    verification: { modelName: AUTH_TABLES.verification },
    advanced: {
      database: { generateId: 'uuid' },
      // Railway's edge writes X-Real-IP with the client's address on every request and replaces any copy a client sends
      // (docs.railway.com, Specs & Limits; staff: "for client-IP rate limiting, X-Real-IP is the header to use"). Not
      // X-Forwarded-For: its hop count is not guaranteed. Services in our own private network can set it freely, and none
      // is there. Where the header is absent, better-auth's limiter has no address and does not count (in development and
      // test it falls back to 127.0.0.1); the /sign-in limit instead falls back to the socket's address (`routes.ts`), so
      // requests without the header share one bucket there. better-auth keys an IPv6 address by its /64 and an
      // IPv4-mapped one as IPv4 (one subscriber holds the whole prefix); `src/auth/ip.ts` does the same for /sign-in.
      ipAddress: { ipAddressHeaders: ['x-real-ip'], ipv6Subnet: 64 },
      // Explicit, so the origin check also holds under NODE_ENV=test, where better-auth skips it by default.
      disableOriginCheck: false,
    },
    // On whatever NODE_ENV says: by default it is only on in production. In memory: one process, one replica (AGENTS.md),
    // so a table would add nothing; a deploy resets the counters, which only gives an attacker a fresh minute.
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 10,
      max: 100,
      customRules: {
        // Starting a Google sign-in, the one route that costs us a call to Google: a person needs a few tries at most.
        '/sign-in/social': { window: 60, max: 10 },
        '/callback/:id': { window: 60, max: 20 },
        // Open registration: a client registers once per install, so a few a minute per address is plenty.
        '/oauth2/register': { window: 60, max: 5 },
      },
    },
    // Warn and above only: nothing about a person goes to the log.
    logger: { level: 'warn', ...(s.log ? { log: s.log } : {}) },
    // Closed over HTTP outright, so each holds even if a plugin's own check changes: the session JWT
    // endpoint, and every route that makes, changes, lists or deletes an OAuth client or a consent.
    disabledPaths: [
      '/sign-up/email',
      '/sign-in/email',
      '/token',
      '/oauth2/create-client',
      '/oauth2/update-client',
      '/oauth2/delete-client',
      '/oauth2/get-client',
      '/oauth2/get-clients',
      '/oauth2/client/rotate-secret',
      '/oauth2/update-consent',
      '/oauth2/delete-consent',
    ],
    plugins: [
      // The issuer is the host itself: the metadata documents live at the root's `.well-known`.
      // No session JWTs: by default every page gets one, signed with the same key as the access tokens.
      jwt({
        disableSettingJwtHeader: true,
        jwt: { issuer: s.publicUrl },
        schema: { jwks: { modelName: AUTH_TABLES.jwks } },
      }),
      mcp({
        loginPage: '/sign-in',
        consentPage: '/oauth/consent',
        resource: mcpUrl(s.publicUrl),
        scopes: [...SCOPES],
        // Public clients only (a metadata-document client has no secret): no client_credentials.
        grantTypes: ['authorization_code', 'refresh_token'],
        // Any agent may connect: by its metadata document (CIMD, below) or, for a client that has none yet (ChatGPT, Cursor and
        // others still register this way), by Dynamic Client Registration, open and rate limited. A registered client can do
        // nothing until a person signs in with Google and consents on a page that shows where it sends them back. Nobody edits,
        // lists or deletes a client over HTTP.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientPrivileges: () => false,
        // Claude needs two flags to register by its metadata document, and falls back to Dynamic Client Registration
        // when either is missing: public clients are accepted ("none", said here) and CIMD is supported (`cimd()` says so).
        advertisedMetadata: { token_endpoint_auth_methods_supported: ['none'] },
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        // Strict rotation: a refresh token works once, with no replay window.
        refreshTokenReuseInterval: 0,
        schema: {
          oauthClient: { modelName: AUTH_TABLES.oauthClient },
          oauthResource: { modelName: AUTH_TABLES.oauthResource },
          oauthClientResource: { modelName: AUTH_TABLES.oauthClientResource },
          oauthClientAssertion: { modelName: AUTH_TABLES.oauthClientAssertion },
          oauthRefreshToken: { modelName: AUTH_TABLES.oauthRefreshToken },
          oauthAccessToken: { modelName: AUTH_TABLES.oauthAccessToken },
          oauthConsent: { modelName: AUTH_TABLES.oauthConsent },
        },
      }),
      // A client whose id is its metadata document's https URL, fetched only from public addresses (`mcp/clients.ts`).
      cimd({
        fetchClientMetadataResource: s.fetchClientMetadataResource ?? fetchOverNode,
        metadataProfile: 'mcp-2026-07-28',
        isMetadataDocumentUrlAllowed: clientIdAllowed,
      }),
    ],
  })
  return instance
}

export type Auth = ReturnType<typeof createAuth>
