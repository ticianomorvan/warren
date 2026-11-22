import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource as fetchOverNode } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { PostgresJSDialect } from 'kysely-postgres-js'
import type { Sql } from '../db'
import { linkSession, type SessionLinks } from './plugin'

/** What a token may be used for. `offline_access` is the refresh token. */
export const SCOPES = ['ledger:read', 'ledger:write', 'offline_access'] as const

/** An access token lives 15 minutes; the refresh token renews it. */
export const ACCESS_TOKEN_SECONDS = 15 * 60

/** The sign-in session only exists to finish consent. */
export const SESSION_SECONDS = 60 * 60

/**
 * Whose client ids may connect. A client's `client_id` is a URL Warren fetches, so only these hosts
 * are ever fetched.
 */
export const CLIENT_ID_HOSTS: readonly string[] = ['claude.ai', 'claude.com']

/** True for an https client id on one of `CLIENT_ID_HOSTS`. Checked before any fetch. */
export function clientIdAllowed(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && CLIENT_ID_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

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
  /** The sign-in's side of the database. */
  links: SessionLinks
  /** How a client's metadata document is fetched. A test passes a fake; the default pins the DNS answer. */
  fetchClientMetadataResource?: ClientMetadataResourceFetch
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void
}

/**
 * The OAuth 2.1 authorization server for Warren's MCP endpoint (slice 5): better-auth on our own database,
 * public clients only, each one a metadata document (CIMD) from an allowed host. Nobody signs in with a
 * password or an email: the `warren-link` plugin makes a session for a person who confirmed on WhatsApp.
 */
export function createAuth(s: AuthSettings) {
  const instance = betterAuth({
    appName: 'Warren',
    baseURL: s.publicUrl,
    secret: s.secret,
    database: { dialect: new PostgresJSDialect({ postgres: s.sql as never }), type: 'postgres' },
    // The migrations are ours (`012_auth.sql`); better-auth never alters the schema.
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
    account: { modelName: AUTH_TABLES.account },
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
        // Finishing a sign-in needs a confirmed WhatsApp answer: nobody needs more than a few tries.
        '/warren/link/complete': { window: 60, max: 10 },
      },
    },
    // Warn and above only: nothing about a person goes to the log.
    logger: { level: 'warn', ...(s.log ? { log: s.log } : {}) },
    // Closed over HTTP outright, so each holds even if a plugin's own check changes: the session JWT
    // endpoint, and every route that makes, changes, lists or deletes an OAuth client or a consent.
    disabledPaths: [
      '/token',
      '/oauth2/register',
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
        // Nobody registers, edits, lists or deletes a client over HTTP: a client exists only as a
        // metadata document from an allowed host.
        clientPrivileges: () => false,
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
      // No Dynamic Client Registration: a client is its own metadata document, from an allowed host.
      cimd({
        fetchClientMetadataResource: s.fetchClientMetadataResource ?? fetchOverNode,
        metadataProfile: 'mcp-2026-07-28',
        isMetadataDocumentUrlAllowed: clientIdAllowed,
      }),
      linkSession(s.links),
    ],
  })
  return instance
}

export type Auth = ReturnType<typeof createAuth>
