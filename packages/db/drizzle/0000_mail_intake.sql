CREATE TABLE "blob_file" (
	"sha256" text PRIMARY KEY NOT NULL,
	"pathname" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_file_pathname_unique" UNIQUE("pathname"),
	CONSTRAINT "blob_file_sha256_hex" CHECK ("blob_file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "blob_file_bytes_positive" CHECK ("blob_file"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbound_mail" (
	"sha256" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_delivery" (
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"mail_sha256" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_delivery_provider_provider_id_pk" PRIMARY KEY("provider","provider_id")
);
--> statement-breakpoint
CREATE TABLE "mail_verdict" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_verdict_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mail_sha256" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"detail" text,
	"policy_version" integer NOT NULL,
	"sender_id" text,
	"from_address" text,
	"signing_domain" text,
	"selector" text,
	"key_record" text,
	"signed_headers" text[],
	"subject" text,
	"signed_date" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_verdict_kind" CHECK ("mail_verdict"."verdict" in ('verified','rejected','retry')),
	CONSTRAINT "mail_verdict_shape" CHECK (("mail_verdict"."verdict" = 'verified') = ("mail_verdict"."sender_id" is not null and "mail_verdict"."signed_date" is not null and "mail_verdict"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "inbound_mail" ADD CONSTRAINT "inbound_mail_sha256_blob_file_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blob_file"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_delivery" ADD CONSTRAINT "mail_delivery_mail_sha256_inbound_mail_sha256_fk" FOREIGN KEY ("mail_sha256") REFERENCES "public"."inbound_mail"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_verdict" ADD CONSTRAINT "mail_verdict_mail_sha256_inbound_mail_sha256_fk" FOREIGN KEY ("mail_sha256") REFERENCES "public"."inbound_mail"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_delivery_mail_ix" ON "mail_delivery" USING btree ("mail_sha256");--> statement-breakpoint
CREATE INDEX "mail_verdict_mail_ix" ON "mail_verdict" USING btree ("mail_sha256","id");