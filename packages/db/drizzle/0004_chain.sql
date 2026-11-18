-- Events are hash-chained per user, over the sealed payload. A user's first link is seeded
-- with their id, so two users with equal payloads never share a hash. Hashing ciphertext
-- means the chain still verifies after the user's key is destroyed.
--
-- The lock is per user. Writers also take it before they insert (recordMailOperation), so the
-- order of `seq` is the order of the chain. The read of the previous link runs under the
-- caller's row-level security, which is the caller's own rows: no security definer.
create function event_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 4201));
  select chain_sha256 into prev from event where user_id = new.user_id order by seq desc limit 1;
  new.payload_sha256 := sha256(new.payload);
  new.chain_sha256 := sha256(
    coalesce(prev, sha256(convert_to('warren:' || new.user_id::text, 'UTF8'))) || new.payload_sha256
  );
  return new;
end $$;
--> statement-breakpoint
create trigger event_chain_bi before insert on event
  for each row execute function event_chain();
