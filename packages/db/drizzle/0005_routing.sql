-- Routing before a user exists: which user does this address, or this WhatsApp message id,
-- belong to? Each function is owned by the migration role, which owns the tables and so is not
-- bound by their policies; each has a fixed search_path; warren_app may only execute them.
-- No "system" setting inside a policy: the policies have no way around them.
create function user_for_mailbox(address text) returns uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select user_id from public.mailbox where address = lower(user_for_mailbox.address) limit 1
$$;
--> statement-breakpoint
revoke all on function user_for_mailbox(text) from public;
--> statement-breakpoint
grant execute on function user_for_mailbox(text) to warren_app;
--> statement-breakpoint
-- Serves the former WhatsApp status webhook, which named only a message id. Migration 0009 drops it.
create function user_for_wamid(wamid text) returns uuid
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select user_id from public.notice_attempt where wamid = user_for_wamid.wamid limit 1
$$;
--> statement-breakpoint
revoke all on function user_for_wamid(text) from public;
--> statement-breakpoint
grant execute on function user_for_wamid(text) to warren_app;
--> statement-breakpoint
create index notice_attempt_wamid_ix on notice_attempt (wamid);
