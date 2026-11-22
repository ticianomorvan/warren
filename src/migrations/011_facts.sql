-- Agent slice F: long-term memory about the person. What they tell Warren about their money and habits
-- ("la visa es la del Galicia", "los cafés ponelos en salidas", "cobro el 5"), kept append-only like movements:
--   kind            alias (a name for a payment, a place or a thing), category (where a kind of expense goes) or
--                   note (anything else, stored and shown only).
--   key             the normalized words the fact is about (lowercase, no accents, single spaces). One live fact per
--                   account, kind and key: the unique index below, so a race cannot make two.
--   inbound_message_id  the message the person said it in (its source). An undo's own rows name the undo message.
--   superseded_by   an update never edits a row: the new row replaces the old one, which points at it. Deferred so a
--                   row can be pointed at before the row it names is inserted (the live index lets only one stand).
--   forgotten_at, forgotten_by   "olvidate de ..." is a soft delete, stamped with the message that asked.
--   restores        the row an undo brings back after a forget (unique: a forget is undone once).
-- No existing row or table changes.
CREATE TABLE fact (
  id                  bigserial   PRIMARY KEY,
  account_id          bigint      NOT NULL REFERENCES account (id),
  kind                text        NOT NULL CHECK (kind IN ('alias', 'category', 'note')),
  key                 text        NOT NULL CHECK (key <> '' AND char_length(key) <= 40),
  value               text        NOT NULL CHECK (value <> '' AND char_length(value) <= 100),
  inbound_message_id  bigint      NOT NULL REFERENCES inbound_message (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  superseded_by       bigint      REFERENCES fact (id) DEFERRABLE INITIALLY DEFERRED,
  forgotten_at        timestamptz,
  forgotten_by        bigint      REFERENCES inbound_message (id),
  restores            bigint      REFERENCES fact (id),
  CONSTRAINT fact_forgotten_pair CHECK ((forgotten_at IS NULL) = (forgotten_by IS NULL)),
  -- Only a live row is replaced or forgotten, so a row never has both endings.
  CONSTRAINT fact_one_ending CHECK (forgotten_at IS NULL OR superseded_by IS NULL)
);

CREATE UNIQUE INDEX fact_live_key_idx ON fact (account_id, kind, key)
  WHERE superseded_by IS NULL AND forgotten_at IS NULL;
CREATE UNIQUE INDEX fact_restores_idx ON fact (restores) WHERE restores IS NOT NULL;
CREATE INDEX fact_account_idx ON fact (account_id, id DESC)
  WHERE superseded_by IS NULL AND forgotten_at IS NULL;
-- What a write batch did (undo): the rows its message inserted, the rows it forgot, the row an update replaced.
CREATE INDEX fact_inbound_idx ON fact (inbound_message_id);
CREATE INDEX fact_forgotten_by_idx ON fact (forgotten_by) WHERE forgotten_by IS NOT NULL;
CREATE INDEX fact_superseded_by_idx ON fact (superseded_by) WHERE superseded_by IS NOT NULL;
