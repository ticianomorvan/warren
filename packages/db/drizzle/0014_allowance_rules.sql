CREATE TABLE "allowance" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "allowance_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"amount" numeric(28, 8) NOT NULL,
	"currency" text NOT NULL,
	"valid_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowance_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "allowance_amount_positive" CHECK ("allowance"."amount" > 0),
	CONSTRAINT "allowance_currency" CHECK ("allowance"."currency" = 'ARS'),
	CONSTRAINT "allowance_valid_from_first" CHECK (extract(day from "allowance"."valid_from") = 1)
);
--> statement-breakpoint
ALTER TABLE "allowance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rule" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "rule_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"match_scheme" text,
	"match_value" text,
	"class" text,
	"revokes" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "rule_revokes_unique" UNIQUE("user_id","revokes"),
	CONSTRAINT "rule_scheme" CHECK ("rule"."match_scheme" in ('counterparty-account','counterparty-tax-id','merchant')),
	CONSTRAINT "rule_class" CHECK ("rule"."class" in ('allowance','fixed','excluded')),
	CONSTRAINT "rule_value" CHECK ("rule"."match_value" <> ''),
	CONSTRAINT "rule_shape" CHECK (("rule"."revokes" is null) = ("rule"."match_scheme" is not null and "rule"."match_value" is not null and "rule"."class" is not null)
        and ("rule"."revokes" is not null) = ("rule"."match_scheme" is null and "rule"."match_value" is null and "rule"."class" is null))
);
--> statement-breakpoint
ALTER TABLE "rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_revokes_fk" FOREIGN KEY ("user_id","revokes") REFERENCES "public"."rule"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowance_valid_ix" ON "allowance" USING btree ("user_id","valid_from","seq");--> statement-breakpoint
CREATE POLICY "allowance_select" ON "allowance" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "allowance_insert" ON "allowance" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "allowance_erase_select" ON "allowance" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "allowance_erase_delete" ON "allowance" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "rule_select" ON "rule" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "rule_insert" ON "rule" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "rule_erase_select" ON "rule" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "rule_erase_delete" ON "rule" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
-- Hand-written, as in 0011 and 0013. An allowance row is a record: the app reads and appends, never updates
-- or deletes. Erasure deletes them (allowance is in ERASED_TABLES, src/tables.ts; a test
-- compares), so the trigger lets only the erasure role delete.
grant select, insert on allowance to warren_app;--> statement-breakpoint
grant select (user_id) on allowance to warren_eraser;--> statement-breakpoint
grant delete on allowance to warren_eraser;--> statement-breakpoint
create trigger allowance_no_mutation before update or delete on allowance
  for each row execute function forbid_mutation_except_erasure();--> statement-breakpoint
create trigger allowance_no_truncate before truncate on allowance
  for each statement execute function forbid_mutation();--> statement-breakpoint
-- Hand-written, as in 0011 and 0013. A rule row (a rule, or the revocation of one) is a record: the app reads and appends, never updates
-- or deletes. Erasure deletes them (rule is in ERASED_TABLES, src/tables.ts; a test
-- compares), so the trigger lets only the erasure role delete.
grant select, insert on rule to warren_app;--> statement-breakpoint
grant select (user_id) on rule to warren_eraser;--> statement-breakpoint
grant delete on rule to warren_eraser;--> statement-breakpoint
create trigger rule_no_mutation before update or delete on rule
  for each row execute function forbid_mutation_except_erasure();--> statement-breakpoint
create trigger rule_no_truncate before truncate on rule
  for each statement execute function forbid_mutation();
