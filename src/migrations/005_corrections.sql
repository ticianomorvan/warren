-- Slice 4: soft delete. A delete never removes the row: it stamps when and by which message.
-- A correction (slice 3's superseded_by, now in use) points the old row at its replacement.
ALTER TABLE movement
  ADD COLUMN deleted_at  timestamptz,
  ADD COLUMN deleted_by  bigint REFERENCES inbound_message (id);

ALTER TABLE movement
  ADD CONSTRAINT movement_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- Only a live row is deleted or corrected, so a row is never both.
  ADD CONSTRAINT movement_one_ending CHECK (deleted_at IS NULL OR superseded_by IS NULL);

-- "Live" now also means not deleted: the partial index follows.
DROP INDEX movement_account_idx;
CREATE INDEX movement_account_idx ON movement (account_id, id DESC)
  WHERE superseded_by IS NULL AND deleted_at IS NULL;
CREATE INDEX movement_account_date_idx ON movement (account_id, occurred_on)
  WHERE superseded_by IS NULL AND deleted_at IS NULL;
