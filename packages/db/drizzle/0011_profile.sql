CREATE TABLE "profile" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"version" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_user_id_version_pk" PRIMARY KEY("user_id","version"),
	CONSTRAINT "profile_version" CHECK ("profile"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "profile_select" ON "profile" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "profile_insert" ON "profile" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "profile_erase_select" ON "profile" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "profile_erase_delete" ON "profile" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
-- Hand-written, as in 0002 and 0003. A profile version is a record: the app reads and appends,
-- never updates or deletes. Erasure deletes them (profile is in ERASED_TABLES, src/tables.ts; a
-- test compares), so the trigger lets only the erasure role delete.
grant select, insert on profile to warren_app;--> statement-breakpoint
grant select (user_id) on profile to warren_eraser;--> statement-breakpoint
grant delete on profile to warren_eraser;--> statement-breakpoint
create trigger profile_no_mutation before update or delete on profile
  for each row execute function forbid_mutation_except_erasure();--> statement-breakpoint
create trigger profile_no_truncate before truncate on profile
  for each statement execute function forbid_mutation();
