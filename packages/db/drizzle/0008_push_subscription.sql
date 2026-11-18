CREATE TABLE "push_subscription" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_key" text NOT NULL,
	"endpoint" "bytea" NOT NULL,
	"p256dh" "bytea" NOT NULL,
	"auth" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("user_id","endpoint_key")
);
--> statement-breakpoint
ALTER TABLE "push_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notice_attempt" DROP CONSTRAINT "notice_attempt_mode";--> statement-breakpoint
ALTER TABLE "notice_attempt" DROP CONSTRAINT "notice_attempt_shape";--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD COLUMN "status_code" integer;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD CONSTRAINT "notice_attempt_push" CHECK (("notice_attempt"."mode" = 'push') = ("notice_attempt"."subscription_id" is not null));--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD CONSTRAINT "notice_attempt_mode" CHECK ("notice_attempt"."mode" in ('text','template','push'));--> statement-breakpoint
ALTER TABLE "notice_attempt" ADD CONSTRAINT "notice_attempt_shape" CHECK (("notice_attempt"."outcome" = 'sent') = (("notice_attempt"."wamid" is not null or "notice_attempt"."subscription_id" is not null) and "notice_attempt"."retryable" is null));--> statement-breakpoint
CREATE POLICY "push_subscription_select" ON "push_subscription" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "push_subscription_insert" ON "push_subscription" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "push_subscription_delete" ON "push_subscription" AS PERMISSIVE FOR DELETE TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "push_subscription_erase_select" ON "push_subscription" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "push_subscription_erase_delete" ON "push_subscription" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
-- Hand-written, as in 0002. A subscription is a setting, not a record: the app reads, adds and
-- deletes its own (turning notifications off, or the push service saying it is gone). It never
-- updates one. No append-only trigger, like user_key and movement. Erasure deletes them
-- (pushSubscription is in ERASED_TABLES, src/tables.ts; a test compares).
grant select, insert, delete on push_subscription to warren_app;--> statement-breakpoint
grant select (user_id) on push_subscription to warren_eraser;--> statement-breakpoint
grant delete on push_subscription to warren_eraser;