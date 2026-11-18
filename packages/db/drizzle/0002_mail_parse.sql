CREATE TABLE "mail_parse" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_parse_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mail_sha256" text NOT NULL,
	"template_set_version" integer NOT NULL,
	"status" text NOT NULL,
	"template_id" text,
	"template_version" integer,
	"reason" text,
	"operation" jsonb,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_parse_once_per_set" UNIQUE("mail_sha256","template_set_version"),
	CONSTRAINT "mail_parse_status" CHECK ("mail_parse"."status" in ('parsed','unparsed')),
	CONSTRAINT "mail_parse_shape" CHECK (("mail_parse"."status" = 'parsed') = ("mail_parse"."operation" is not null and "mail_parse"."template_id" is not null and "mail_parse"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "mail_parse" ADD CONSTRAINT "mail_parse_mail_sha256_inbound_mail_sha256_fk" FOREIGN KEY ("mail_sha256") REFERENCES "public"."inbound_mail"("sha256") ON DELETE no action ON UPDATE no action;