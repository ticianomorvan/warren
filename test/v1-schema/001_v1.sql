-- The v1 (main, tag v1-final) database structure, from pg_dump -s of production: no data. Used by the import tests as the source.


CREATE TABLE account (
    id bigint NOT NULL,
    wa_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mcp_revoked_at timestamp with time zone
);

CREATE SEQUENCE account_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE account_id_seq OWNED BY account.id;

CREATE TABLE auth_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" uuid NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth_jwks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);

CREATE TABLE auth_oauth_access_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" uuid,
    "userId" uuid,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "refreshId" uuid,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);

CREATE TABLE auth_oauth_client (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    "clientDiscoveryId" text,
    disabled boolean,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes jsonb,
    "clientCredentialsScopes" jsonb,
    "userId" uuid,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    "applicationType" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean,
    "referenceId" text,
    metadata jsonb
);

CREATE TABLE auth_oauth_client_assertion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth_oauth_client_resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);

CREATE TABLE auth_oauth_consent (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "clientId" text NOT NULL,
    "userId" uuid,
    "referenceId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    scopes jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth_oauth_refresh_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" uuid,
    "userId" uuid NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    "authTime" timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);

CREATE TABLE auth_oauth_resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean,
    disabled boolean,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer,
    metadata jsonb
);

CREATE TABLE auth_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" uuid NOT NULL
);

CREATE TABLE auth_user (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    warren_account_id bigint
);

CREATE TABLE auth_verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE fact (
    id bigint NOT NULL,
    account_id bigint NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    inbound_message_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by bigint,
    forgotten_at timestamp with time zone,
    forgotten_by bigint,
    restores bigint,
    CONSTRAINT fact_forgotten_pair CHECK (((forgotten_at IS NULL) = (forgotten_by IS NULL))),
    CONSTRAINT fact_key_check CHECK (((key <> ''::text) AND (char_length(key) <= 40))),
    CONSTRAINT fact_kind_check CHECK ((kind = ANY (ARRAY['alias'::text, 'category'::text, 'note'::text]))),
    CONSTRAINT fact_one_ending CHECK (((forgotten_at IS NULL) OR (superseded_by IS NULL))),
    CONSTRAINT fact_value_check CHECK (((value <> ''::text) AND (char_length(value) <= 100)))
);

CREATE SEQUENCE fact_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE fact_id_seq OWNED BY fact.id;

CREATE TABLE inbound_message (
    id bigint NOT NULL,
    wamid text NOT NULL,
    wa_id text NOT NULL,
    kind text NOT NULL,
    body text,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    meta_ts timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    typing_sent_at timestamp with time zone,
    reply_sent_at timestamp with time zone,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    send_started_at timestamp with time zone,
    command jsonb,
    reply_text text,
    model_ms integer,
    interim_sent_at timestamp with time zone,
    failure_sent_at timestamp with time zone,
    asked_numbers integer[],
    asked_ids bigint[],
    parsed jsonb,
    action text,
    tool_calls jsonb,
    model_turns smallint,
    pending jsonb,
    undoes bigint,
    timings jsonb,
    channel text DEFAULT 'whatsapp'::text NOT NULL,
    CONSTRAINT inbound_message_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'mcp'::text]))),
    CONSTRAINT inbound_message_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text, 'ignored'::text, 'unknown'::text]))),
    CONSTRAINT inbound_message_undoes_other CHECK (((undoes IS NULL) OR (undoes <> id)))
);

CREATE SEQUENCE inbound_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE inbound_message_id_seq OWNED BY inbound_message.id;

CREATE TABLE link_request (
    id bigint NOT NULL,
    code text NOT NULL,
    secret_hash text NOT NULL,
    client_name text NOT NULL,
    ip_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    account_id bigint,
    asked_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    used_at timestamp with time zone,
    CONSTRAINT link_request_asked CHECK (((account_id IS NULL) = (asked_at IS NULL))),
    CONSTRAINT link_request_code_check CHECK ((code ~ '^[A-Z0-9]{6}$'::text)),
    CONSTRAINT link_request_confirmed CHECK (((confirmed_at IS NULL) OR (asked_at IS NOT NULL)))
);

CREATE SEQUENCE link_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE link_request_id_seq OWNED BY link_request.id;

CREATE TABLE movement (
    id bigint NOT NULL,
    account_id bigint NOT NULL,
    inbound_message_id bigint NOT NULL,
    "position" integer NOT NULL,
    direction text NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL,
    occurred_on date NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    payment text,
    confidence text NOT NULL,
    superseded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by bigint,
    restores bigint,
    CONSTRAINT movement_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT movement_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'low'::text]))),
    CONSTRAINT movement_currency_check CHECK ((currency = ANY (ARRAY['ARS'::text, 'USD'::text]))),
    CONSTRAINT movement_deleted_pair CHECK (((deleted_at IS NULL) = (deleted_by IS NULL))),
    CONSTRAINT movement_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT movement_one_ending CHECK (((deleted_at IS NULL) OR (superseded_by IS NULL))),
    CONSTRAINT movement_position_check CHECK (("position" >= 0))
);

CREATE SEQUENCE movement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE movement_id_seq OWNED BY movement.id;

CREATE TABLE reminder (
    id bigint NOT NULL,
    account_id bigint NOT NULL,
    what text NOT NULL,
    schedule jsonb NOT NULL,
    next_due_at timestamp with time zone,
    sent_count integer DEFAULT 0 NOT NULL,
    inbound_message_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by bigint,
    restores bigint,
    CONSTRAINT reminder_cancelled_pair CHECK (((cancelled_at IS NULL) = (cancelled_by IS NULL))),
    CONSTRAINT reminder_what_check CHECK (((what <> ''::text) AND (char_length(what) <= 100) AND (what !~ '[[:cntrl:]]'::text)))
);

CREATE SEQUENCE reminder_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE reminder_id_seq OWNED BY reminder.id;

CREATE TABLE reminder_send (
    id bigint NOT NULL,
    reminder_id bigint NOT NULL,
    due_at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    wamid text,
    status text NOT NULL,
    error_code integer,
    CONSTRAINT reminder_send_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'template'::text]))),
    CONSTRAINT reminder_send_status_check CHECK ((status = ANY (ARRAY['started'::text, 'sent'::text, 'failed'::text, 'unknown'::text, 'capped'::text, 'retry_template'::text])))
);

CREATE SEQUENCE reminder_send_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE reminder_send_id_seq OWNED BY reminder_send.id;

CREATE TABLE reply (
    id bigint NOT NULL,
    outbound_wamid text NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    failed_at timestamp with time zone,
    inbound_id bigint
);

CREATE SEQUENCE reply_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE reply_id_seq OWNED BY reply.id;


ALTER TABLE ONLY account ALTER COLUMN id SET DEFAULT nextval('account_id_seq'::regclass);

ALTER TABLE ONLY fact ALTER COLUMN id SET DEFAULT nextval('fact_id_seq'::regclass);

ALTER TABLE ONLY inbound_message ALTER COLUMN id SET DEFAULT nextval('inbound_message_id_seq'::regclass);

ALTER TABLE ONLY link_request ALTER COLUMN id SET DEFAULT nextval('link_request_id_seq'::regclass);

ALTER TABLE ONLY movement ALTER COLUMN id SET DEFAULT nextval('movement_id_seq'::regclass);

ALTER TABLE ONLY reminder ALTER COLUMN id SET DEFAULT nextval('reminder_id_seq'::regclass);

ALTER TABLE ONLY reminder_send ALTER COLUMN id SET DEFAULT nextval('reminder_send_id_seq'::regclass);

ALTER TABLE ONLY reply ALTER COLUMN id SET DEFAULT nextval('reply_id_seq'::regclass);

ALTER TABLE ONLY account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY account
    ADD CONSTRAINT account_wa_id_key UNIQUE (wa_id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_jwks
    ADD CONSTRAINT auth_jwks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT auth_oauth_access_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT auth_oauth_access_token_token_key UNIQUE (token);

ALTER TABLE ONLY auth_oauth_client_assertion
    ADD CONSTRAINT auth_oauth_client_assertion_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_client
    ADD CONSTRAINT "auth_oauth_client_clientId_key" UNIQUE ("clientId");

ALTER TABLE ONLY auth_oauth_client
    ADD CONSTRAINT auth_oauth_client_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_client_resource
    ADD CONSTRAINT auth_oauth_client_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_consent
    ADD CONSTRAINT auth_oauth_consent_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_refresh_token
    ADD CONSTRAINT auth_oauth_refresh_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_oauth_refresh_token
    ADD CONSTRAINT auth_oauth_refresh_token_token_key UNIQUE (token);

ALTER TABLE ONLY auth_oauth_resource
    ADD CONSTRAINT auth_oauth_resource_identifier_key UNIQUE (identifier);

ALTER TABLE ONLY auth_oauth_resource
    ADD CONSTRAINT auth_oauth_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_token_key UNIQUE (token);

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_email_key UNIQUE (email);

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_warren_account_id_key UNIQUE (warren_account_id);

ALTER TABLE ONLY auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inbound_message
    ADD CONSTRAINT inbound_message_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inbound_message
    ADD CONSTRAINT inbound_message_wamid_key UNIQUE (wamid);

ALTER TABLE ONLY link_request
    ADD CONSTRAINT link_request_code_key UNIQUE (code);

ALTER TABLE ONLY link_request
    ADD CONSTRAINT link_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_request
    ADD CONSTRAINT link_request_secret_hash_key UNIQUE (secret_hash);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_inbound_message_id_position_key UNIQUE (inbound_message_id, "position");

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_pkey PRIMARY KEY (id);

ALTER TABLE ONLY reminder
    ADD CONSTRAINT reminder_pkey PRIMARY KEY (id);

ALTER TABLE ONLY reminder_send
    ADD CONSTRAINT reminder_send_once UNIQUE (reminder_id, due_at);

ALTER TABLE ONLY reminder_send
    ADD CONSTRAINT reminder_send_pkey PRIMARY KEY (id);

ALTER TABLE ONLY reply
    ADD CONSTRAINT reply_outbound_wamid_key UNIQUE (outbound_wamid);

ALTER TABLE ONLY reply
    ADD CONSTRAINT reply_pkey PRIMARY KEY (id);


CREATE INDEX "auth_account_userId_idx" ON auth_account USING btree ("userId");

CREATE INDEX "auth_oauth_access_token_authorizationCodeId_idx" ON auth_oauth_access_token USING btree ("authorizationCodeId");

CREATE INDEX "auth_oauth_access_token_clientId_idx" ON auth_oauth_access_token USING btree ("clientId");

CREATE INDEX "auth_oauth_access_token_refreshId_idx" ON auth_oauth_access_token USING btree ("refreshId");

CREATE INDEX "auth_oauth_access_token_sessionId_idx" ON auth_oauth_access_token USING btree ("sessionId");

CREATE INDEX "auth_oauth_access_token_userId_idx" ON auth_oauth_access_token USING btree ("userId");

CREATE INDEX "auth_oauth_client_resource_clientId_idx" ON auth_oauth_client_resource USING btree ("clientId");

CREATE UNIQUE INDEX "auth_oauth_client_resource_clientId_resourceId_uidx" ON auth_oauth_client_resource USING btree ("clientId", "resourceId");

CREATE INDEX "auth_oauth_client_resource_resourceId_idx" ON auth_oauth_client_resource USING btree ("resourceId");

CREATE INDEX "auth_oauth_client_userId_idx" ON auth_oauth_client USING btree ("userId");

CREATE INDEX "auth_oauth_consent_clientId_idx" ON auth_oauth_consent USING btree ("clientId");

CREATE INDEX "auth_oauth_consent_userId_idx" ON auth_oauth_consent USING btree ("userId");

CREATE INDEX "auth_oauth_refresh_token_authorizationCodeId_idx" ON auth_oauth_refresh_token USING btree ("authorizationCodeId");

CREATE INDEX "auth_oauth_refresh_token_clientId_idx" ON auth_oauth_refresh_token USING btree ("clientId");

CREATE INDEX "auth_oauth_refresh_token_sessionId_idx" ON auth_oauth_refresh_token USING btree ("sessionId");

CREATE INDEX "auth_oauth_refresh_token_userId_idx" ON auth_oauth_refresh_token USING btree ("userId");

CREATE INDEX "auth_session_userId_idx" ON auth_session USING btree ("userId");

CREATE INDEX auth_verification_identifier_idx ON auth_verification USING btree (identifier);

CREATE INDEX fact_account_idx ON fact USING btree (account_id, id DESC) WHERE ((superseded_by IS NULL) AND (forgotten_at IS NULL));

CREATE INDEX fact_forgotten_by_idx ON fact USING btree (forgotten_by) WHERE (forgotten_by IS NOT NULL);

CREATE INDEX fact_inbound_idx ON fact USING btree (inbound_message_id);

CREATE UNIQUE INDEX fact_live_key_idx ON fact USING btree (account_id, kind, key) WHERE ((superseded_by IS NULL) AND (forgotten_at IS NULL));

CREATE UNIQUE INDEX fact_restores_idx ON fact USING btree (restores) WHERE (restores IS NOT NULL);

CREATE INDEX fact_superseded_by_idx ON fact USING btree (superseded_by) WHERE (superseded_by IS NOT NULL);

CREATE INDEX inbound_message_open_idx ON inbound_message USING btree (status, updated_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

CREATE INDEX inbound_message_received_idx ON inbound_message USING btree (received_at DESC);

CREATE INDEX inbound_message_sender_idx ON inbound_message USING btree (wa_id, id DESC);

CREATE UNIQUE INDEX inbound_message_undoes_idx ON inbound_message USING btree (undoes) WHERE (undoes IS NOT NULL);

CREATE INDEX inbound_message_window_idx ON inbound_message USING btree (wa_id, received_at DESC) WHERE (channel = 'whatsapp'::text);

CREATE INDEX link_request_ip_idx ON link_request USING btree (ip_hash, created_at);

CREATE INDEX movement_account_date_idx ON movement USING btree (account_id, occurred_on) WHERE ((superseded_by IS NULL) AND (deleted_at IS NULL));

CREATE INDEX movement_account_idx ON movement USING btree (account_id, id DESC) WHERE ((superseded_by IS NULL) AND (deleted_at IS NULL));

CREATE INDEX movement_deleted_by_idx ON movement USING btree (deleted_by) WHERE (deleted_by IS NOT NULL);

CREATE UNIQUE INDEX movement_restores_idx ON movement USING btree (restores) WHERE (restores IS NOT NULL);

CREATE INDEX movement_superseded_by_idx ON movement USING btree (superseded_by) WHERE (superseded_by IS NOT NULL);

CREATE INDEX reminder_account_idx ON reminder USING btree (account_id, id DESC) WHERE (cancelled_at IS NULL);

CREATE INDEX reminder_cancelled_by_idx ON reminder USING btree (cancelled_by) WHERE (cancelled_by IS NOT NULL);

CREATE INDEX reminder_due_idx ON reminder USING btree (next_due_at) WHERE ((next_due_at IS NOT NULL) AND (cancelled_at IS NULL));

CREATE INDEX reminder_inbound_idx ON reminder USING btree (inbound_message_id) WHERE (inbound_message_id IS NOT NULL);

CREATE UNIQUE INDEX reminder_restores_idx ON reminder USING btree (restores) WHERE (restores IS NOT NULL);

CREATE INDEX reminder_send_retry_idx ON reminder_send USING btree (id) WHERE (status = 'retry_template'::text);

CREATE INDEX reminder_send_started_idx ON reminder_send USING btree (started_at DESC);

CREATE INDEX reminder_send_wamid_idx ON reminder_send USING btree (wamid) WHERE (wamid IS NOT NULL);

CREATE INDEX reply_inbound_idx ON reply USING btree (inbound_id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT "auth_oauth_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth_oauth_client("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT "auth_oauth_access_token_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES auth_oauth_refresh_token(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT "auth_oauth_access_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth_session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth_oauth_access_token
    ADD CONSTRAINT "auth_oauth_access_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_client_resource
    ADD CONSTRAINT "auth_oauth_client_resource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth_oauth_client("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_client_resource
    ADD CONSTRAINT "auth_oauth_client_resource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES auth_oauth_resource(identifier) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_client
    ADD CONSTRAINT "auth_oauth_client_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_consent
    ADD CONSTRAINT "auth_oauth_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth_oauth_client("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_consent
    ADD CONSTRAINT "auth_oauth_consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_refresh_token
    ADD CONSTRAINT "auth_oauth_refresh_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth_oauth_client("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth_oauth_refresh_token
    ADD CONSTRAINT "auth_oauth_refresh_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth_session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth_oauth_refresh_token
    ADD CONSTRAINT "auth_oauth_refresh_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_user
    ADD CONSTRAINT auth_user_warren_account_id_fkey FOREIGN KEY (warren_account_id) REFERENCES account(id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_account_id_fkey FOREIGN KEY (account_id) REFERENCES account(id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_forgotten_by_fkey FOREIGN KEY (forgotten_by) REFERENCES inbound_message(id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES inbound_message(id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_restores_fkey FOREIGN KEY (restores) REFERENCES fact(id);

ALTER TABLE ONLY fact
    ADD CONSTRAINT fact_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES fact(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY inbound_message
    ADD CONSTRAINT inbound_message_undoes_fkey FOREIGN KEY (undoes) REFERENCES inbound_message(id);

ALTER TABLE ONLY link_request
    ADD CONSTRAINT link_request_account_id_fkey FOREIGN KEY (account_id) REFERENCES account(id);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_account_id_fkey FOREIGN KEY (account_id) REFERENCES account(id);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES inbound_message(id);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES inbound_message(id);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_restores_fkey FOREIGN KEY (restores) REFERENCES movement(id);

ALTER TABLE ONLY movement
    ADD CONSTRAINT movement_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES movement(id);

ALTER TABLE ONLY reminder
    ADD CONSTRAINT reminder_account_id_fkey FOREIGN KEY (account_id) REFERENCES account(id);

ALTER TABLE ONLY reminder
    ADD CONSTRAINT reminder_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES inbound_message(id);

ALTER TABLE ONLY reminder
    ADD CONSTRAINT reminder_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES inbound_message(id);

ALTER TABLE ONLY reminder
    ADD CONSTRAINT reminder_restores_fkey FOREIGN KEY (restores) REFERENCES reminder(id);

ALTER TABLE ONLY reminder_send
    ADD CONSTRAINT reminder_send_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES reminder(id);

ALTER TABLE ONLY reply
    ADD CONSTRAINT reply_inbound_id_fkey FOREIGN KEY (inbound_id) REFERENCES inbound_message(id);


