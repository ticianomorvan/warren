-- Events are append-only and hash-chained. Appends are serialised; volume is tens per day.
create function event_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(4201);
  select chain_sha256 into prev from event order by seq desc limit 1;
  new.payload_sha256 := sha256(convert_to(new.payload::text, 'UTF8'));
  new.chain_sha256 := sha256(coalesce(prev, ''::bytea) || new.payload_sha256);
  return new;
end $$;
--> statement-breakpoint
create trigger event_chain_bi before insert on event
  for each row execute function event_chain();
--> statement-breakpoint
create trigger event_no_mutation before update or delete on event
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger event_no_truncate before truncate on event
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger account_no_mutation before update or delete on account
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger account_no_truncate before truncate on account
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger account_identifier_no_mutation before update or delete on account_identifier
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger account_identifier_no_truncate before truncate on account_identifier
  for each statement execute function forbid_mutation();
--> statement-breakpoint
revoke all on account, account_identifier, event, movement, movement_source from public;
--> statement-breakpoint
-- The app can never decide which accounts are the owner's: it only reads them.
grant select on account, account_identifier to warren_app;
--> statement-breakpoint
grant select, insert on event to warren_app;
--> statement-breakpoint
-- Derived state: the app keeps it current, and it can be rebuilt from events.
grant select, insert, update on movement to warren_app;
--> statement-breakpoint
grant select, insert on movement_source to warren_app;
