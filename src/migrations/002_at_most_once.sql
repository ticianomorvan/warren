-- At-most-once sends: send_started_at is committed before the Graph call, and a row that died after
-- that point becomes 'unknown' instead of being sent again.
ALTER TABLE inbound_message ADD COLUMN send_started_at timestamptz;
ALTER TABLE inbound_message DROP CONSTRAINT inbound_message_status_check;
ALTER TABLE inbound_message ADD CONSTRAINT inbound_message_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'ignored', 'unknown'));
-- One clock for every stage timestamp: the database's.
ALTER TABLE inbound_message ALTER COLUMN received_at SET DEFAULT now();

-- Slice 3 references inbound_message.id everywhere, so reply does too.
ALTER TABLE reply ADD COLUMN inbound_id bigint REFERENCES inbound_message (id);
UPDATE reply r SET inbound_id = m.id FROM inbound_message m WHERE m.wamid = r.inbound_wamid;
DROP INDEX reply_inbound_idx;
ALTER TABLE reply DROP COLUMN inbound_wamid;
CREATE INDEX reply_inbound_idx ON reply (inbound_id);
