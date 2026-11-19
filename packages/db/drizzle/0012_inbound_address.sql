CREATE TABLE "inbound_address" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "inbound_address_user_id_token_pk" PRIMARY KEY("user_id","token"),
	CONSTRAINT "inbound_address_token_unique" UNIQUE("token"),
	CONSTRAINT "inbound_address_token_format" CHECK ("inbound_address"."token" ~ '^u-[a-z2-7]{22}$')
);
--> statement-breakpoint
ALTER TABLE "inbound_address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_address" ADD CONSTRAINT "inbound_address_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_address_active_ix" ON "inbound_address" USING btree ("user_id") WHERE "inbound_address"."revoked_at" is null;--> statement-breakpoint
CREATE POLICY "inbound_address_select" ON "inbound_address" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_address_insert" ON "inbound_address" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_address_update" ON "inbound_address" AS PERMISSIVE FOR UPDATE TO "warren_app" USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_address_erase_select" ON "inbound_address" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "inbound_address_erase_delete" ON "inbound_address" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
-- Hand-written, as in 0002 and 0008. An address is a setting with one change: revoking it. The
-- app reads, adds, and sets `revoked_at` (a column grant: it cannot change the token or the
-- owner). No delete and no append-only trigger, like mailbox. Erasure deletes the rows
-- (inboundAddress is in ERASED_TABLES, src/tables.ts; a test compares).
grant select, insert on inbound_address to warren_app;--> statement-breakpoint
grant update (revoked_at) on inbound_address to warren_app;--> statement-breakpoint
grant select (user_id) on inbound_address to warren_eraser;--> statement-breakpoint
grant delete on inbound_address to warren_eraser;--> statement-breakpoint
-- As user_for_mailbox (0005): security definer, fixed search_path, execute for warren_app only.
-- A revoked address routes nowhere.
create function user_for_inbound_address(token text) returns uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select user_id from public.inbound_address
  where token = lower(user_for_inbound_address.token) and revoked_at is null limit 1
$$;--> statement-breakpoint
revoke all on function user_for_inbound_address(text) from public;--> statement-breakpoint
grant execute on function user_for_inbound_address(text) to warren_app;
