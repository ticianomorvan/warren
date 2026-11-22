-- Speed pass: where the time of a message goes, per stage, so `pnpm latency` can show it.
--   timings  one JSON object per answered message (see src/timings.ts): ms from received to claimed, the
--            context reads, each model turn (call, reads it ran, tokens), the commit, the send stamp and the
--            send. Written with the sent reply; null on rows from before, which the report leaves out.
ALTER TABLE inbound_message ADD COLUMN timings jsonb;
