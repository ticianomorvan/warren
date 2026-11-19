CREATE TABLE "forwarding_confirmation" (
	"user_id" uuid DEFAULT app_user_id() NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "forwarding_confirmation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"address_hash" text NOT NULL,
	"data" "bytea" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "forwarding_confirmation_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "forwarding_confirmation_hash" CHECK ("forwarding_confirmation"."address_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "forwarding_confirmation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forwarding_confirmation" ADD CONSTRAINT "forwarding_confirmation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forwarding_confirmation_ix" ON "forwarding_confirmation" USING btree ("user_id","address_hash","received_at");--> statement-breakpoint
CREATE POLICY "forwarding_confirmation_select" ON "forwarding_confirmation" AS PERMISSIVE FOR SELECT TO "warren_app" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "forwarding_confirmation_insert" ON "forwarding_confirmation" AS PERMISSIVE FOR INSERT TO "warren_app" WITH CHECK (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "forwarding_confirmation_erase_select" ON "forwarding_confirmation" AS PERMISSIVE FOR SELECT TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
CREATE POLICY "forwarding_confirmation_erase_delete" ON "forwarding_confirmation" AS PERMISSIVE FOR DELETE TO "warren_eraser" USING (user_id = app_user_id());--> statement-breakpoint
-- Hand-written, as in 0011. A confirmation is a record: the app reads and appends, never updates
-- or deletes. Erasure deletes them (forwardingConfirmation is in ERASED_TABLES, src/tables.ts; a
-- test compares), so the trigger lets only the erasure role delete.
grant select, insert on forwarding_confirmation to warren_app;--> statement-breakpoint
grant select (user_id) on forwarding_confirmation to warren_eraser;--> statement-breakpoint
grant delete on forwarding_confirmation to warren_eraser;--> statement-breakpoint
create trigger forwarding_confirmation_no_mutation before update or delete on forwarding_confirmation
  for each row execute function forbid_mutation_except_erasure();--> statement-breakpoint
create trigger forwarding_confirmation_no_truncate before truncate on forwarding_confirmation
  for each statement execute function forbid_mutation();--> statement-breakpoint
-- The only way for warren_app to add a mailbox. Like user_for_mailbox (0005): security definer
-- (so it may insert where the app has no grant), fixed search_path, execute for warren_app only.
-- It acts for the transaction's user, `app_user_id()` (the `app.user_id` that `asUser` sets): no
-- user, no claim, and a caller cannot name another one. It inserts only when that user holds a
-- confirmation, captured from Google's signed mail, for this address from the last 7 days.
-- Order matters: the confirmation is checked before the unique violation, so an address held by
-- someone else cannot be probed without having been confirmed to this user.
-- Returns 'claimed', 'already-yours', 'taken' or 'no-confirmation'.
create function claim_mailbox(address text) returns text
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user uuid := public.app_user_id();
  v_address text := lower(btrim(claim_mailbox.address));
begin
  if v_user is null or v_address = '' then
    return 'no-confirmation';
  end if;
  if exists (select 1 from public.mailbox m where m.user_id = v_user and m.address = v_address) then
    return 'already-yours';
  end if;
  if not exists (
    select 1 from public.forwarding_confirmation f
    where f.user_id = v_user
      and f.address_hash = encode(sha256(convert_to(v_address, 'UTF8')), 'hex')
      and f.received_at > now() - interval '7 days'
  ) then
    return 'no-confirmation';
  end if;
  begin
    insert into public.mailbox (user_id, address) values (v_user, v_address);
  exception when unique_violation then
    return 'taken';
  end;
  return 'claimed';
end
$$;--> statement-breakpoint
revoke all on function claim_mailbox(text) from public;--> statement-breakpoint
grant execute on function claim_mailbox(text) to warren_app;
