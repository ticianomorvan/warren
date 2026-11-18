-- Mail intake tables are append-only: a correction is always a new row.
-- The triggers hold for every role, including the one that runs migrations.
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
-- The deployed app connects as warren_app, which can read and append and nothing else.
-- The role is created without a login; set its password once, by hand (see README).
do $$ begin
  if not exists (select from pg_roles where rolname = 'warren_app') then
    create role warren_app nologin;
  end if;
end $$;
--> statement-breakpoint
revoke all on blob_file, inbound_mail, mail_delivery, mail_verdict from public;
--> statement-breakpoint
grant usage on schema public to warren_app;
--> statement-breakpoint
grant select, insert on blob_file, inbound_mail, mail_delivery, mail_verdict to warren_app;
