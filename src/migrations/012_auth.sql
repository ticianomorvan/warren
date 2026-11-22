-- Slice 5: people as accounts, and Warren over MCP (docs/mcp-spec.md, slice 1).
--
-- Part 1, better-auth's tables. This is what better-auth 1.7.26 creates for our config (`src/auth/config.ts`:
-- the jwt, mcp and cimd plugins), printed by `pnpm tsx src/auth/print-schema.ts` and formatted. Two changes
-- of ours: every table is `auth_*` because its `account` is not our `account`, and `auth_user` has
-- `warren_account_id`, the person (our `account` row) the user stands for. better-auth never migrates at
-- runtime; a test fails when a plugin or an upgrade wants a table or a column that is not here.
--   auth_user.email is the placeholder `a<id>@users.invalid`: better-auth requires one, and no personal data goes in it.
--   auth_account and auth_verification: better-auth's own; accounts stay empty (nobody has a password or a social login).
--   auth_verification holds the one-use authorization codes; auth_jwks the signing keys of the access tokens.
--
CREATE TABLE "auth_user" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz DEFAULT now() NOT NULL,
  "warren_account_id" bigint UNIQUE REFERENCES account (id)
);

CREATE TABLE "auth_session" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE
);

CREATE TABLE "auth_account" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "auth_verification" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "auth_jwks" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

CREATE TABLE "auth_oauth_client" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb,
  "userId" uuid REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb NOT NULL,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean,
  "referenceId" text,
  "metadata" jsonb
);

CREATE TABLE "auth_oauth_resource" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean,
  "disabled" boolean,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer,
  "metadata" jsonb
);

CREATE TABLE "auth_oauth_client_resource" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "auth_oauth_client" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "auth_oauth_resource" ("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "createdAt" timestamptz
);

CREATE TABLE "auth_oauth_refresh_token" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "auth_oauth_client" ("clientId") ON DELETE CASCADE,
  "sessionId" uuid REFERENCES "auth_session" ("id") ON DELETE SET NULL,
  "userId" uuid NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE "auth_oauth_access_token" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "auth_oauth_client" ("clientId") ON DELETE CASCADE,
  "sessionId" uuid REFERENCES "auth_session" ("id") ON DELETE SET NULL,
  "userId" uuid REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" uuid REFERENCES "auth_oauth_refresh_token" ("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE "auth_oauth_consent" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "auth_oauth_client" ("clientId") ON DELETE CASCADE,
  "userId" uuid REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "auth_oauth_client_assertion" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);

CREATE INDEX "auth_session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" ON "auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");
CREATE INDEX "auth_oauth_client_userId_idx" ON "auth_oauth_client" ("userId");
CREATE INDEX "auth_oauth_client_resource_clientId_idx" ON "auth_oauth_client_resource" ("clientId");
CREATE INDEX "auth_oauth_client_resource_resourceId_idx" ON "auth_oauth_client_resource" ("resourceId");
CREATE INDEX "auth_oauth_refresh_token_clientId_idx" ON "auth_oauth_refresh_token" ("clientId");
CREATE INDEX "auth_oauth_refresh_token_sessionId_idx" ON "auth_oauth_refresh_token" ("sessionId");
CREATE INDEX "auth_oauth_refresh_token_userId_idx" ON "auth_oauth_refresh_token" ("userId");
CREATE INDEX "auth_oauth_refresh_token_authorizationCodeId_idx" ON "auth_oauth_refresh_token" ("authorizationCodeId");
CREATE INDEX "auth_oauth_access_token_clientId_idx" ON "auth_oauth_access_token" ("clientId");
CREATE INDEX "auth_oauth_access_token_sessionId_idx" ON "auth_oauth_access_token" ("sessionId");
CREATE INDEX "auth_oauth_access_token_userId_idx" ON "auth_oauth_access_token" ("userId");
CREATE INDEX "auth_oauth_access_token_authorizationCodeId_idx" ON "auth_oauth_access_token" ("authorizationCodeId");
CREATE INDEX "auth_oauth_access_token_refreshId_idx" ON "auth_oauth_access_token" ("refreshId");
CREATE INDEX "auth_oauth_consent_clientId_idx" ON "auth_oauth_consent" ("clientId");
CREATE INDEX "auth_oauth_consent_userId_idx" ON "auth_oauth_consent" ("userId");
CREATE UNIQUE INDEX "auth_oauth_client_resource_clientId_resourceId_uidx" ON "auth_oauth_client_resource" ("clientId", "resourceId");

-- Part 2, the sign-in by WhatsApp. One row per time a browser opens `/sign-in` for an OAuth flow:
--   code          what the person sends to Warren ("vincular K7M2QX"); 6 characters, no look-alikes (0/O, 1/I/L).
--   secret_hash   sha256 of the secret in the browser's httpOnly cookie: only that browser can finish the sign-in.
--   client_name   what the confirmation question names ("Claude (claude.ai)").
--   expires_at    10 minutes after the page was opened.
--   account_id, asked_at   set when an allowed sender sent the code: Warren then asked "¿Conectar ...?".
--   confirmed_at  the sender's "sí". Without it the browser is never signed in.
--   used_at       the sign-in was spent (or refused with "no"): a request works once.
CREATE TABLE link_request (
  id            bigserial   PRIMARY KEY,
  code          text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6}$'),
  secret_hash   text        NOT NULL UNIQUE,
  client_name   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  account_id    bigint      REFERENCES account (id),
  asked_at      timestamptz,
  confirmed_at  timestamptz,
  used_at       timestamptz,
  CONSTRAINT link_request_asked CHECK ((account_id IS NULL) = (asked_at IS NULL)),
  CONSTRAINT link_request_confirmed CHECK (confirmed_at IS NULL OR asked_at IS NOT NULL)
);

-- "Is there a question open for this sender?" is read on every message of a person who has one.
CREATE INDEX link_request_open_idx ON link_request (account_id) WHERE used_at IS NULL AND confirmed_at IS NULL;
