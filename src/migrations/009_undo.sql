-- Agent slice C: undo. No new table: a write batch is the inbound message that made the changes, and what it
-- did to each movement is already in the ledger (a row it inserted, the row a correction replaced, a row it
-- deleted). What was missing is only the mark of an undo, kept append-only like everything else:
--   inbound_message.undoes  on the message that says "deshacer": the batch it reverted. Unique, so a batch is
--                           undone once, whatever races.
--   movement.restores       on the row an undo inserts to bring back a deleted one: the deleted row it restores.
--                           (Undoing a correction supersedes the correction with a new row, so it needs no link.)
-- Both are nullable and unset on every existing row, so existing rows stay valid and mean what they meant.
ALTER TABLE inbound_message
  ADD COLUMN undoes bigint REFERENCES inbound_message (id),
  ADD CONSTRAINT inbound_message_undoes_other CHECK (undoes IS NULL OR undoes <> id);
CREATE UNIQUE INDEX inbound_message_undoes_idx ON inbound_message (undoes) WHERE undoes IS NOT NULL;

ALTER TABLE movement
  ADD COLUMN restores bigint REFERENCES movement (id);
CREATE UNIQUE INDEX movement_restores_idx ON movement (restores) WHERE restores IS NOT NULL;

-- What a batch changed is found by message: the rows it inserted (the unique key already covers them), the rows
-- it deleted and the rows its corrections replaced. And the sender's newest batches are found by sender.
CREATE INDEX movement_deleted_by_idx ON movement (deleted_by) WHERE deleted_by IS NOT NULL;
CREATE INDEX movement_superseded_by_idx ON movement (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX inbound_message_sender_idx ON inbound_message (wa_id, id DESC);
