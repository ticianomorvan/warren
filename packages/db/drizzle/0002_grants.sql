-- Grants are the first wall, row-level security (0001) the second, triggers (0003) the third.
revoke all on all tables in schema public from public;
--> statement-breakpoint
grant usage on schema public to warren_app, warren_auth, warren_eraser;
--> statement-breakpoint
-- The app reads and appends. It never updates or deletes, except `movement`, which is derived
-- state it keeps current.
grant select, insert on
  user_key, blob_file, inbound_mail, mail_delivery, mail_verdict, mail_parse, event,
  movement, movement_source, notice, notice_attempt, notice_status
  to warren_app;
--> statement-breakpoint
grant update on movement to warren_app;
--> statement-breakpoint
-- The app can never decide which accounts or mailboxes are a user's: it only reads them.
-- The operator writes them (pnpm ledger:accounts, pnpm mailbox:add).
grant select on account, account_identifier, mailbox to warren_app;
--> statement-breakpoint
-- It can see that a user was erased, so a missing key is never quietly made again.
grant select on erasure to warren_app;
--> statement-breakpoint
-- Mail nobody claimed: written without a user, never read back.
grant insert on unrouted_delivery to warren_app;
--> statement-breakpoint
-- Better Auth. These four tables are the only ones it touches, and warren_app has no grant on
-- them, so no query that runs for a user can read another user's password hash or session.
-- A user row is never deleted: every user_id points at it.
grant select, insert, update on "user" to warren_auth;
--> statement-breakpoint
grant select, insert, update, delete on session, auth_account, verification to warren_auth;
--> statement-breakpoint
-- Erasure: delete the user's own rows and key, write the tombstone, read the chain head.
-- These seven tables are the erasure set (ERASED_TABLES in src/tables.ts; a test compares).
-- Column grants for what it only needs to find rows by.
grant select (user_id) on
  user_key, mailbox, movement, movement_source, notice, account, account_identifier
  to warren_eraser;
--> statement-breakpoint
grant delete on
  user_key, mailbox, movement, movement_source, notice, account, account_identifier
  to warren_eraser;
--> statement-breakpoint
grant select (user_id, seq, chain_sha256) on event to warren_eraser;
--> statement-breakpoint
grant select, insert on erasure to warren_eraser;
