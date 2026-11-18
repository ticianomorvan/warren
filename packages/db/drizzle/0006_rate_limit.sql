CREATE TABLE "rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);

--> statement-breakpoint
-- Only Better Auth reads and writes it, as warren_auth. warren_app has no grant on it, like the
-- other auth tables. Rows hold client addresses, never a user id.
grant select, insert, update, delete on rate_limit to warren_auth;
--> statement-breakpoint
-- A user who was erased gets no session, even from a sign-in that began before erasure and
-- finished after it. The check is a trigger so it holds whatever the app does: `for share`
-- waits for an erasure in flight (which holds the user row until it commits) and then sees its
-- result, and the erasure updates the user row before it deletes their sessions, so a session
-- either never gets in or is deleted by the erasure.
create function refuse_session_for_erased_user() returns trigger language plpgsql as $$
declare
  erased timestamptz;
begin
  -- The lock is taken on the row by id alone, not on "erased_at is not null": a row that does
  -- not match the filter in its committed version is skipped without waiting.
  select erased_at into erased from "user" where id = new.user_id for share;
  if erased is not null then
    raise exception 'user erased: no session' using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger session_not_for_erased_user before insert on session
  for each row execute function refuse_session_for_erased_user();
