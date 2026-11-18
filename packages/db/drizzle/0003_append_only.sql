-- Append-only tables: a correction is always a new row. The triggers hold for every role,
-- including the one that runs migrations.
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'append-only: % on %', tg_op, tg_table_name;
end $$;
--> statement-breakpoint
create trigger blob_file_no_mutation before update or delete on blob_file
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger blob_file_no_truncate before truncate on blob_file
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger inbound_mail_no_mutation before update or delete on inbound_mail
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger inbound_mail_no_truncate before truncate on inbound_mail
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_delivery_no_mutation before update or delete on mail_delivery
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_delivery_no_truncate before truncate on mail_delivery
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_verdict_no_mutation before update or delete on mail_verdict
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_verdict_no_truncate before truncate on mail_verdict
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_parse_no_mutation before update or delete on mail_parse
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_parse_no_truncate before truncate on mail_parse
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
create trigger event_no_mutation before update or delete on event
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger event_no_truncate before truncate on event
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger notice_attempt_no_mutation before update or delete on notice_attempt
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger notice_attempt_no_truncate before truncate on notice_attempt
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger notice_status_no_mutation before update or delete on notice_status
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger notice_status_no_truncate before truncate on notice_status
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger erasure_no_mutation before update or delete on erasure
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger erasure_no_truncate before truncate on erasure
  for each statement execute function forbid_mutation();
--> statement-breakpoint
create trigger unrouted_delivery_no_mutation before update or delete on unrouted_delivery
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger unrouted_delivery_no_truncate before truncate on unrouted_delivery
  for each statement execute function forbid_mutation();
--> statement-breakpoint
-- `notice` is append-only too, with one exception: erasing a user deletes their notices,
-- because they point at movements, which erasure deletes. Only the erasure role may delete.
create function forbid_mutation_except_erasure() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_user = 'warren_eraser' then
    return old;
  end if;
  raise exception 'append-only: % on %', tg_op, tg_table_name;
end $$;
--> statement-breakpoint
create trigger notice_no_mutation before update or delete on notice
  for each row execute function forbid_mutation_except_erasure();
--> statement-breakpoint
create trigger notice_no_truncate before truncate on notice
  for each statement execute function forbid_mutation();
