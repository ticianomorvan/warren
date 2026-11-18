CREATE TABLE "notice" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notice_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_movement_id_unique" UNIQUE("movement_id")
);
--> statement-breakpoint
CREATE TABLE "notice_attempt" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notice_attempt_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notice_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"body" text NOT NULL,
	"wamid" text,
	"error_code" integer,
	"retryable" boolean,
	"detail" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_attempt_wamid_unique" UNIQUE("wamid"),
	CONSTRAINT "notice_attempt_mode" CHECK ("notice_attempt"."mode" in ('text','template')),
	CONSTRAINT "notice_attempt_outcome" CHECK ("notice_attempt"."outcome" in ('sent','failed')),
	CONSTRAINT "notice_attempt_shape" CHECK (("notice_attempt"."outcome" = 'sent') = ("notice_attempt"."wamid" is not null and "notice_attempt"."retryable" is null))
);
--> statement-breakpoint
CREATE TABLE "notice_status" (
	"wamid" text NOT NULL,
	"status" text NOT NULL,
	"error_code" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_status_wamid_status_pk" PRIMARY KEY("wamid","status"),
	CONSTRAINT "notice_status_kind" CHECK ("notice_status"."status" in ('sent','delivered','read','failed'))
);
--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_movement_id_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD CONSTRAINT "notice_attempt_notice_id_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_status" ADD CONSTRAINT "notice_status_wamid_notice_attempt_wamid_fk" FOREIGN KEY ("wamid") REFERENCES "public"."notice_attempt"("wamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_attempt_notice_ix" ON "notice_attempt" USING btree ("notice_id","id");