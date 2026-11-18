-- Notices are append-only like everything else: a retry or a delivery report is a new row.
create trigger notice_no_mutation before update or delete on notice
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger notice_no_truncate before truncate on notice
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
revoke all on notice, notice_attempt, notice_status from public;
--> statement-breakpoint
grant select, insert on notice, notice_attempt, notice_status to warren_app;
