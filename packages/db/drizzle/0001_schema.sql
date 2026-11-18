CREATE TABLE "account" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"institution" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "account_kind" CHECK ("account"."kind" in ('asset','liability'))
);
--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account_identifier" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identifier_user_id_scheme_value_pk" PRIMARY KEY("user_id","scheme","value"),
	CONSTRAINT "account_identifier_scheme" CHECK ("account_identifier"."scheme" in ('cbu','bank-label'))
);
--> statement-breakpoint
ALTER TABLE "account_identifier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_file" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"mail_id" text NOT NULL,
	"pathname" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_file_user_id_mail_id_pk" PRIMARY KEY("user_id","mail_id"),
	CONSTRAINT "blob_file_pathname_unique" UNIQUE("user_id","pathname"),
	CONSTRAINT "blob_file_mail_id_hex" CHECK ("blob_file"."mail_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "blob_file_bytes_positive" CHECK ("blob_file"."bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "blob_file" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "erasure" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"chain_head" "bytea",
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_user_id_pk" PRIMARY KEY("user_id")
);
--> statement-breakpoint
ALTER TABLE "erasure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "event" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" uuid NOT NULL,
	"payload" "bytea" NOT NULL,
	"payload_sha256" "bytea",
	"chain_sha256" "bytea",
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_user_id_seq_pk" PRIMARY KEY("user_id","seq"),
	CONSTRAINT "event_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "event_kind" CHECK ("event"."kind" in ('movement','link')),
	CONSTRAINT "event_actor" CHECK ("event"."actor" in ('core','owner','agent','import'))
);
--> statement-breakpoint
ALTER TABLE "event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbound_mail" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"mail_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_mail_user_id_mail_id_pk" PRIMARY KEY("user_id","mail_id")
);
--> statement-breakpoint
ALTER TABLE "inbound_mail" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_delivery" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"mail_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_delivery_user_id_provider_provider_id_pk" PRIMARY KEY("user_id","provider","provider_id")
);
--> statement-breakpoint
ALTER TABLE "mail_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_parse" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mail_parse_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mail_id" text NOT NULL,
	"template_set_version" integer NOT NULL,
	"status" text NOT NULL,
	"template_id" text,
	"template_version" integer,
	"reason" text,
	"operation" "bytea",
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_parse_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "mail_parse_once_per_set" UNIQUE("user_id","mail_id","template_set_version"),
	CONSTRAINT "mail_parse_status" CHECK ("mail_parse"."status" in ('parsed','unparsed')),
	CONSTRAINT "mail_parse_shape" CHECK (("mail_parse"."status" = 'parsed') = ("mail_parse"."operation" is not null and "mail_parse"."template_id" is not null and "mail_parse"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "mail_parse" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_verdict" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mail_verdict_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mail_id" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"detail" "bytea",
	"policy_version" integer NOT NULL,
	"sender_id" text,
	"from_address" text,
	"signing_domain" text,
	"selector" text,
	"key_record" text,
	"signed_headers" text[],
	"subject" "bytea",
	"signed_date" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_verdict_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "mail_verdict_kind" CHECK ("mail_verdict"."verdict" in ('verified','rejected','retry')),
	CONSTRAINT "mail_verdict_shape" CHECK (("mail_verdict"."verdict" = 'verified') = ("mail_verdict"."sender_id" is not null and "mail_verdict"."signed_date" is not null and "mail_verdict"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "mail_verdict" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mailbox" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_user_id_address_pk" PRIMARY KEY("user_id","address"),
	CONSTRAINT "mailbox_address_unique" UNIQUE("address"),
	CONSTRAINT "mailbox_address_lower" CHECK ("mailbox"."address" = lower("mailbox"."address"))
);
--> statement-breakpoint
ALTER TABLE "mailbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "movement" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"currency" text NOT NULL,
	"date" date NOT NULL,
	"time" time,
	"account_id" text,
	"counter_account_id" text,
	"counterparty_name" text,
	"counterparty_account" text,
	"counterparty_tax_id" text,
	"reference" text,
	"reason" text,
	"type" text NOT NULL,
	"last_event_seq" bigint NOT NULL,
	CONSTRAINT "movement_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "movement_direction" CHECK ("movement"."direction" in ('in','out')),
	CONSTRAINT "movement_amount_positive" CHECK ("movement"."amount" > 0),
	CONSTRAINT "movement_type" CHECK ("movement"."type" in ('own_transfer','unclassified')),
	CONSTRAINT "movement_own_transfer" CHECK (("movement"."type" = 'own_transfer') = ("movement"."counter_account_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "movement_source" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"mail_id" text NOT NULL,
	"movement_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"operation" "bytea" NOT NULL,
	"event_seq" bigint NOT NULL,
	CONSTRAINT "movement_source_user_id_mail_id_pk" PRIMARY KEY("user_id","mail_id")
);
--> statement-breakpoint
ALTER TABLE "movement_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notice" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "notice_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "notice_movement_unique" UNIQUE("user_id","movement_id")
);
--> statement-breakpoint
ALTER TABLE "notice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notice_attempt" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "notice_attempt_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notice_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"body" "bytea" NOT NULL,
	"wamid" text,
	"error_code" integer,
	"retryable" boolean,
	"detail" "bytea",
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_attempt_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "notice_attempt_wamid_unique" UNIQUE("user_id","wamid"),
	CONSTRAINT "notice_attempt_mode" CHECK ("notice_attempt"."mode" in ('text','template')),
	CONSTRAINT "notice_attempt_outcome" CHECK ("notice_attempt"."outcome" in ('sent','failed')),
	CONSTRAINT "notice_attempt_shape" CHECK (("notice_attempt"."outcome" = 'sent') = ("notice_attempt"."wamid" is not null and "notice_attempt"."retryable" is null))
);
--> statement-breakpoint
ALTER TABLE "notice_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notice_status" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"wamid" text NOT NULL,
	"status" text NOT NULL,
	"error_code" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_status_user_id_wamid_status_pk" PRIMARY KEY("user_id","wamid","status"),
	CONSTRAINT "notice_status_kind" CHECK ("notice_status"."status" in ('sent','delivered','read','failed'))
);
--> statement-breakpoint
ALTER TABLE "notice_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "unrouted_delivery" (
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unrouted_delivery_provider_provider_id_pk" PRIMARY KEY("provider","provider_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_key" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"wrap_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_key_user_id_pk" PRIMARY KEY("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identifier" ADD CONSTRAINT "account_identifier_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identifier" ADD CONSTRAINT "account_identifier_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_file" ADD CONSTRAINT "blob_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure" ADD CONSTRAINT "erasure_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_mail" ADD CONSTRAINT "inbound_mail_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_mail" ADD CONSTRAINT "inbound_mail_blob_fk" FOREIGN KEY ("user_id","mail_id") REFERENCES "public"."blob_file"("user_id","mail_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery" ADD CONSTRAINT "mail_delivery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery" ADD CONSTRAINT "mail_delivery_mail_fk" FOREIGN KEY ("user_id","mail_id") REFERENCES "public"."inbound_mail"("user_id","mail_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_parse" ADD CONSTRAINT "mail_parse_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_parse" ADD CONSTRAINT "mail_parse_mail_fk" FOREIGN KEY ("user_id","mail_id") REFERENCES "public"."inbound_mail"("user_id","mail_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_verdict" ADD CONSTRAINT "mail_verdict_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_verdict" ADD CONSTRAINT "mail_verdict_mail_fk" FOREIGN KEY ("user_id","mail_id") REFERENCES "public"."inbound_mail"("user_id","mail_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_counter_account_fk" FOREIGN KEY ("user_id","counter_account_id") REFERENCES "public"."account"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_source" ADD CONSTRAINT "movement_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_source" ADD CONSTRAINT "movement_source_mail_fk" FOREIGN KEY ("user_id","mail_id") REFERENCES "public"."inbound_mail"("user_id","mail_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_source" ADD CONSTRAINT "movement_source_movement_fk" FOREIGN KEY ("user_id","movement_id") REFERENCES "public"."movement"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_movement_fk" FOREIGN KEY ("user_id","movement_id") REFERENCES "public"."movement"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD CONSTRAINT "notice_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_status" ADD CONSTRAINT "notice_status_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_status" ADD CONSTRAINT "notice_status_attempt_fk" FOREIGN KEY ("user_id","wamid") REFERENCES "public"."notice_attempt"("user_id","wamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_key" ADD CONSTRAINT "user_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_ix" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_subject_ix" ON "event" USING btree ("user_id","subject");--> statement-breakpoint
CREATE INDEX "mail_delivery_mail_ix" ON "mail_delivery" USING btree ("user_id","mail_id");--> statement-breakpoint
CREATE INDEX "mail_verdict_mail_ix" ON "mail_verdict" USING btree ("user_id","mail_id","id");--> statement-breakpoint
CREATE INDEX "movement_match_ix" ON "movement" USING btree ("user_id","date","amount","currency","direction");--> statement-breakpoint
CREATE INDEX "movement_source_movement_ix" ON "movement_source" USING btree ("user_id","movement_id","event_seq");--> statement-breakpoint
CREATE INDEX "notice_attempt_notice_ix" ON "notice_attempt" USING btree ("user_id","notice_id","id");--> statement-breakpoint
CREATE INDEX "session_user_ix" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_ix" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE POLICY "account_select" ON "account" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "account_insert" ON "account" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "account_identifier_select" ON "account_identifier" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "account_identifier_insert" ON "account_identifier" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "blob_file_select" ON "blob_file" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "blob_file_insert" ON "blob_file" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "erasure_select" ON "erasure" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "erasure_insert" ON "erasure" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "erasure_erase_select" ON "erasure" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "erasure_erase_insert" ON "erasure" AS PERMISSIVE FOR INSERT TO "warren_eraser" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "event_select" ON "event" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "event_insert" ON "event" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "event_erase_select" ON "event" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_mail_select" ON "inbound_mail" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_mail_insert" ON "inbound_mail" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_delivery_select" ON "mail_delivery" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_delivery_insert" ON "mail_delivery" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_parse_select" ON "mail_parse" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_parse_insert" ON "mail_parse" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_verdict_select" ON "mail_verdict" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mail_verdict_insert" ON "mail_verdict" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mailbox_select" ON "mailbox" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mailbox_insert" ON "mailbox" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mailbox_erase_select" ON "mailbox" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "mailbox_erase_delete" ON "mailbox" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_select" ON "movement" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_insert" ON "movement" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_update" ON "movement" AS PERMISSIVE FOR UPDATE TO "warren_app" USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_erase_select" ON "movement" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_erase_delete" ON "movement" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_source_select" ON "movement_source" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_source_insert" ON "movement_source" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_source_erase_select" ON "movement_source" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "movement_source_erase_delete" ON "movement_source" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_select" ON "notice" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_insert" ON "notice" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_erase_select" ON "notice" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_erase_delete" ON "notice" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_attempt_select" ON "notice_attempt" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_attempt_insert" ON "notice_attempt" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_status_select" ON "notice_status" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "notice_status_insert" ON "notice_status" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "user_key_select" ON "user_key" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "user_key_insert" ON "user_key" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "user_key_erase_select" ON "user_key" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "user_key_erase_delete" ON "user_key" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());