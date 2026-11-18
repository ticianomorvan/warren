-- Roles and the one helper the schema needs before it exists. Hand-written; the generated
-- schema in 0001 refers to both, so this runs first. Roles are created without a login: set
-- each role's password once, by hand (see README). `if not exists`, because roles outlive the
-- schema, and the owner may already have made them.
--
--   warren_app     the deployed app. Reads and appends, under row-level security.
--   warren_auth    Better Auth. The four auth tables and nothing else.
--   warren_eraser  erases one user: deletes derived rows and the user's key. Nothing else.
do $$ begin
  if not exists (select from pg_roles where rolname = 'warren_app') then
    create role warren_app nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'warren_auth') then
    create role warren_auth nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'warren_eraser') then
    create role warren_eraser nologin;
  end if;
end $$;
--> statement-breakpoint
-- The user a transaction acts for, set by `asUser` with set_config(..., is_local => true).
-- Outside such a transaction it is NULL, so a policy matches no row and an insert fails on
-- `not null`. An empty string (what a finished transaction leaves behind) counts as no user.
create function app_user_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
