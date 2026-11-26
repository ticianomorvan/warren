-- Sign-in and OAuth for MCP (docs/design.md, "Auth"): better-auth's tables, and the one way a person's data leaves.
--
-- Part 1 is what better-auth creates for our config (src/auth/config.ts: Google sign-in, the jwt, mcp and cimd plugins, and the
-- oauth-provider they sit on), as printed by `getMigrations(auth.options).compileMigrations()` and formatted; migrations.test checks
-- that it is still all better-auth wants. better-auth never migrates at runtime. Two changes of ours: every table is `auth_*` (its
-- `account` is not our `account`), and `auth_user.warren_account_id` is the person (our `account` row) the user stands for.
--   auth_user.email is the Google account's email: how a person is found by the import command and how they are told apart.
--   auth_account holds the Google login of a user; Warren stores none of Google's tokens (src/auth/config.ts blanks them).
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


COMMENT ON TABLE auth_user IS 'better-auth: one row per person who signed in with Google; warren_account_id is the account the user stands for.';
COMMENT ON TABLE auth_session IS 'better-auth: one row per sign-in session; it lives to finish consent and to use the account page.';
COMMENT ON TABLE auth_account IS 'better-auth: one row per login method of a user (Google). Holds no token.';
COMMENT ON TABLE auth_verification IS 'better-auth: one row per one-use authorization code or verification token.';
COMMENT ON TABLE auth_jwks IS 'better-auth jwt plugin: one row per signing key of the access tokens.';
COMMENT ON TABLE auth_oauth_client IS 'oauth-provider: one row per OAuth client (Claude, registered from its CIMD document).';
COMMENT ON TABLE auth_oauth_resource IS 'oauth-provider: one row per protected resource (the /mcp audience) a token may be issued for.';
COMMENT ON TABLE auth_oauth_client_resource IS 'oauth-provider: one row per resource a client is allowed to ask for.';
COMMENT ON TABLE auth_oauth_refresh_token IS 'oauth-provider: one row per refresh token, rotated on use.';
COMMENT ON TABLE auth_oauth_access_token IS 'oauth-provider: one row per opaque access token it issued.';
COMMENT ON TABLE auth_oauth_consent IS 'oauth-provider: one row per scope set a user consented to for a client.';
COMMENT ON TABLE auth_oauth_client_assertion IS 'oauth-provider: one row per client-assertion identifier seen, to refuse a replay.';

-- Part 2, the one way out. Deleting an account is the single exception to append-only: every row of the person goes in one
-- transaction, through this function. It names the account in the transaction-local setting `warren.erasing`, which is the only thing
-- `append_only()` accepts for a DELETE, and clears it before it returns. Only src/auth/account.ts calls it (a test holds that).
CREATE FUNCTION erase_account(target bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('warren.erasing', target::text, true);
  DELETE FROM mcp_request WHERE account_id = target;
  DELETE FROM movement WHERE account_id = target;
  DELETE FROM fact WHERE account_id = target;
  DELETE FROM turn WHERE account_id = target;
  -- The sign-in side: the user, and by cascade its sessions, logins, consents and tokens.
  DELETE FROM auth_user WHERE warren_account_id = target;
  DELETE FROM account WHERE id = target;
  PERFORM set_config('warren.erasing', '', true);
END $$;
COMMENT ON FUNCTION erase_account(bigint) IS 'Deletes every row of one account in the caller''s transaction: the only DELETE append_only() lets through.';
