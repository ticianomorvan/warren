create trigger mail_parse_no_mutation before update or delete on mail_parse
  for each row execute function forbid_mutation();
--> statement-breakpoint
create trigger mail_parse_no_truncate before truncate on mail_parse
  for each statement execute function forbid_mutation();
--> statement-breakpoint
revoke all on mail_parse from public;
--> statement-breakpoint
grant select, insert on mail_parse to warren_app;
