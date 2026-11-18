CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"institution" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_kind" CHECK ("account"."kind" in ('asset','liability'))
);
--> statement-breakpoint
CREATE TABLE "account_identifier" (
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identifier_scheme_value_pk" PRIMARY KEY("scheme","value"),
	CONSTRAINT "account_identifier_scheme" CHECK ("account_identifier"."scheme" in ('cbu','bank-label'))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" "bytea",
	"chain_sha256" "bytea",
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_id_unique" UNIQUE("id"),
	CONSTRAINT "event_kind" CHECK ("event"."kind" in ('movement','link')),
	CONSTRAINT "event_actor" CHECK ("event"."actor" in ('core','owner','agent','import'))
);
--> statement-breakpoint
CREATE TABLE "movement" (
	"id" uuid PRIMARY KEY NOT NULL,
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
	CONSTRAINT "movement_direction" CHECK ("movement"."direction" in ('in','out')),
	CONSTRAINT "movement_amount_positive" CHECK ("movement"."amount" > 0),
	CONSTRAINT "movement_type" CHECK ("movement"."type" in ('own_transfer','unclassified')),
	CONSTRAINT "movement_own_transfer" CHECK (("movement"."type" = 'own_transfer') = ("movement"."counter_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "movement_source" (
	"mail_sha256" text PRIMARY KEY NOT NULL,
	"movement_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"operation" jsonb NOT NULL,
	"event_seq" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_identifier" ADD CONSTRAINT "account_identifier_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement" ADD CONSTRAINT "movement_counter_account_id_account_id_fk" FOREIGN KEY ("counter_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_source" ADD CONSTRAINT "movement_source_mail_sha256_inbound_mail_sha256_fk" FOREIGN KEY ("mail_sha256") REFERENCES "public"."inbound_mail"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_source" ADD CONSTRAINT "movement_source_movement_id_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_subject_ix" ON "event" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "movement_match_ix" ON "movement" USING btree ("date","amount","currency","direction");--> statement-breakpoint
CREATE INDEX "movement_source_movement_ix" ON "movement_source" USING btree ("movement_id","event_seq");