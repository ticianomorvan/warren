-- Warren's schema, as it would be written today (docs/design.md, "Data").
-- One file, no superseded steps. Every column, constraint and index is named on purpose, and every table says what a row is.
--
-- The shape in three sentences:
--   * `turn` is the commit point: one row per committed unit of work, inserted only inside the commit transaction.
--   * `movement` and `fact` are versioned: a change inserts a new version of the same entity and ends the old one.
--   * The person's data is append-only (`append_only()` below): only the ended pair changes in place, and a row is deleted only by
--     `erase_account` (002_auth.sql), the one way out.

-- ---------------------------------------------------------------------------------------------------------------------
-- The person

CREATE TABLE account (
  id              bigserial   PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- "Disconnect all agents" sets it: the MCP door refuses every access token issued at or before it.
  mcp_revoked_at  timestamptz
);
COMMENT ON TABLE account IS 'One row per person. Every write transaction first locks it (SELECT 1 FROM account WHERE id = $1 FOR NO KEY UPDATE), the one lock of the person''s data.';

-- ---------------------------------------------------------------------------------------------------------------------
-- The commit point

CREATE TABLE turn (
  id          bigserial   PRIMARY KEY,
  account_id  bigint      NOT NULL REFERENCES account (id),
  -- Who made it: the OAuth client id from the verified token (a URL), or 'cli' for the import command.
  client      text        NOT NULL CONSTRAINT turn_client_not_empty CHECK (client <> ''),
  created_at  timestamptz NOT NULL DEFAULT now(),
  calls       jsonb       NOT NULL DEFAULT '[]' CONSTRAINT turn_calls_array CHECK (jsonb_typeof(calls) = 'array'),  -- the tool calls and their outcomes (scrubbed of a secret's inputs)
  record      text,                                    -- what code rendered for the changes; null when nothing was changed
  undoes      bigint,                                  -- the turn this one reverted: an earlier turn of the same account
  -- What references a turn by (id, account_id) stays within one account: a version made or ended in, and an undo of, another person's turn cannot exist.
  CONSTRAINT turn_id_account UNIQUE (id, account_id),
  CONSTRAINT turn_undoes_earlier CHECK (undoes IS NULL OR undoes < id),
  CONSTRAINT turn_undoes_same_account FOREIGN KEY (undoes, account_id) REFERENCES turn (id, account_id)
);
-- A turn is undone once, whatever races.
CREATE UNIQUE INDEX turn_undoes_once ON turn (undoes) WHERE undoes IS NOT NULL;
-- The person's newest turns (the undo's "last turn"); undo order is commit order, which is id order.
CREATE INDEX turn_account_idx ON turn (account_id, id DESC);
COMMENT ON TABLE turn IS 'One row per committed unit of work. It is inserted only in the commit transaction, so its existence is the commit point; it is never updated.';

CREATE TABLE mcp_request (
  account_id  bigint      NOT NULL REFERENCES account (id),
  request_id  text        NOT NULL CONSTRAINT mcp_request_id_not_empty CHECK (request_id <> ''),
  input_hash  text        NOT NULL,                    -- sha256 of the tool and its checked input: an id may stand for one call only
  turn_id     bigint      NOT NULL REFERENCES turn (id),
  result      jsonb       NOT NULL,                    -- what the client was given: a retry gets it back
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_request_pkey PRIMARY KEY (account_id, request_id)
);
CREATE INDEX mcp_request_turn_idx ON mcp_request (turn_id);
COMMENT ON TABLE mcp_request IS 'One row per MCP write that made a turn, keyed by the client''s request_id: a retry of the same call gets the first answer and writes nothing.';

-- ---------------------------------------------------------------------------------------------------------------------
-- Versioned stores. The shared columns of movement and fact:
--   entity_id  the same across every version of a thing; MCP clients see this id.
--   made_in    the turn that inserted this version.
--   ended_in / ended_at   the turn that ended this version (a correction, a delete, a forget, an undo) and when.
--              Live means ended_at IS NULL. Both are set together, once.
-- A correction inserts a new version of the same entity_id in the same transaction that ends the old one.
-- made_in / ended_in reference `turn` (with the account, so a version can only belong to its own person's turns) DEFERRABLE INITIALLY DEFERRED: the commit transaction applies the writes first and inserts the turn row last
-- (its existence is the commit point), so the reference is checked at COMMIT. A transaction that never inserts its turn cannot commit a version.

CREATE SEQUENCE movement_entity_seq AS bigint;
CREATE TABLE movement (
  id           bigserial   PRIMARY KEY,
  entity_id    bigint      NOT NULL DEFAULT nextval('movement_entity_seq'),
  account_id   bigint      NOT NULL REFERENCES account (id),
  made_in      bigint      NOT NULL,
  ended_in     bigint,
  ended_at     timestamptz,
  logged_at    timestamptz NOT NULL DEFAULT now(),       -- when the entity was first logged: a correction passes the original in its INSERT
  direction    text        NOT NULL CONSTRAINT movement_direction_known CHECK (direction IN ('in', 'out')),
  amount       numeric     NOT NULL
               CONSTRAINT movement_amount_positive CHECK (amount > 0)
               CONSTRAINT movement_amount_cents CHECK (scale(amount) <= 2),
  currency     text        NOT NULL CONSTRAINT movement_currency_known CHECK (currency IN ('ARS', 'USD')),
  occurred_on  date        NOT NULL,                      -- the Argentine calendar day
  description  text        NOT NULL CONSTRAINT movement_description_not_empty CHECK (description <> ''),
  category     text        NOT NULL CONSTRAINT movement_category_not_empty CHECK (category <> ''),  -- the closed set lives in code
  payment      text,
  confidence   text        NOT NULL CONSTRAINT movement_confidence_known CHECK (confidence IN ('high', 'low')),
  -- What find_movements matches words against: description and category, lowercased and without Spanish accents
  -- (the same fold as v1: translate('áéíóúüñ', 'aeiouun')). `unaccent()` is not immutable, so it cannot be used here.
  search       text        GENERATED ALWAYS AS (
                 lower(translate(description || ' ' || replace(category, '_', ' '), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))
               ) STORED,
  CONSTRAINT movement_ended_pair CHECK ((ended_at IS NULL) = (ended_in IS NULL)),
  CONSTRAINT movement_made_in_turn FOREIGN KEY (made_in, account_id) REFERENCES turn (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT movement_ended_in_turn FOREIGN KEY (ended_in, account_id) REFERENCES turn (id, account_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER SEQUENCE movement_entity_seq OWNED BY movement.entity_id;
CREATE UNIQUE INDEX movement_one_live_version ON movement (entity_id) WHERE ended_at IS NULL;
CREATE INDEX movement_live_idx ON movement (account_id, id DESC) WHERE ended_at IS NULL;
CREATE INDEX movement_live_day_idx ON movement (account_id, occurred_on) WHERE ended_at IS NULL;
-- What a turn did, for the undo: the versions it made and the versions it ended.
CREATE INDEX movement_made_in_idx ON movement (made_in);
CREATE INDEX movement_ended_in_idx ON movement (ended_in) WHERE ended_in IS NOT NULL;
COMMENT ON TABLE movement IS 'One row per version of a money movement (an expense or an income). A correction or delete ends the version and may insert the next; only the ended pair ever changes.';

CREATE SEQUENCE fact_entity_seq AS bigint;
CREATE TABLE fact (
  id          bigserial   PRIMARY KEY,
  entity_id   bigint      NOT NULL DEFAULT nextval('fact_entity_seq'),
  account_id  bigint      NOT NULL REFERENCES account (id),
  made_in     bigint      NOT NULL,
  ended_in    bigint,
  ended_at    timestamptz,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  kind        text        NOT NULL CONSTRAINT fact_kind_known CHECK (kind IN ('alias', 'category', 'note')),
  key         text        NOT NULL CONSTRAINT fact_key_length CHECK (key <> '' AND char_length(key) <= 40),     -- normalized words the fact is about
  value       text        NOT NULL CONSTRAINT fact_value_length CHECK (value <> '' AND char_length(value) <= 100),
  CONSTRAINT fact_ended_pair CHECK ((ended_at IS NULL) = (ended_in IS NULL)),
  CONSTRAINT fact_made_in_turn FOREIGN KEY (made_in, account_id) REFERENCES turn (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fact_ended_in_turn FOREIGN KEY (ended_in, account_id) REFERENCES turn (id, account_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER SEQUENCE fact_entity_seq OWNED BY fact.entity_id;
CREATE UNIQUE INDEX fact_one_live_version ON fact (entity_id) WHERE ended_at IS NULL;
-- One live fact per account, kind and key: a race cannot make two.
CREATE UNIQUE INDEX fact_one_live_key ON fact (account_id, kind, key) WHERE ended_at IS NULL;
CREATE INDEX fact_live_idx ON fact (account_id, id DESC) WHERE ended_at IS NULL;
CREATE INDEX fact_made_in_idx ON fact (made_in);
CREATE INDEX fact_ended_in_idx ON fact (ended_in) WHERE ended_in IS NOT NULL;
COMMENT ON TABLE fact IS 'One row per version of something the person told Warren to remember (an alias, a category rule or a note), in their words. A new value or a forget ends the version; only the ended pair ever changes.';

-- ---------------------------------------------------------------------------------------------------------------------
-- Append-only guard. Attached to every table of the person's data; the arguments are the columns that may change in place.
--   * no DELETE;
--   * an UPDATE may touch only the listed columns;
--   * `ended_in`/`ended_at` change once: from NULL, together (the table's *_ended_pair CHECK keeps them together);
--   * a DELETE is allowed only inside `erase_account` (002_auth.sql), which names the account it is erasing in the transaction-local
--     setting `warren.erasing`: a row of another account, or any other statement, still raises.
-- Runs on PGlite and on Postgres alike (both ship plpgsql). The triggers are AFTER ROW: a BEFORE trigger sees the stored generated
-- column (`movement.search`) not yet computed in NEW, so it would always look changed. Raising in an AFTER trigger aborts the statement all the same.

CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  -- With no arguments TG_ARGV is not an empty array, and `jsonb - NULL` is NULL: nothing may change.
  allowed text[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('warren.erasing', true) IS NOT DISTINCT FROM OLD.account_id::text THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION '% is append-only: a row is never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  IF (new_row - allowed) IS DISTINCT FROM (old_row - allowed) THEN
    RAISE EXCEPTION '% is append-only: only % may change in place', TG_TABLE_NAME, COALESCE(NULLIF(array_to_string(allowed, ', '), ''), 'nothing')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF 'ended_at' = ANY (allowed)
     AND old_row -> 'ended_at' <> 'null'::jsonb
     AND (new_row -> 'ended_at' <> old_row -> 'ended_at' OR new_row -> 'ended_in' <> old_row -> 'ended_in') THEN
    RAISE EXCEPTION '% is append-only: a version that ended does not change its ending', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION append_only() IS 'The append-only guard: trigger arguments name the columns that may change in place.';

CREATE TRIGGER turn_append_only AFTER UPDATE OR DELETE ON turn
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER mcp_request_append_only AFTER UPDATE OR DELETE ON mcp_request
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER movement_append_only AFTER UPDATE OR DELETE ON movement
  FOR EACH ROW EXECUTE FUNCTION append_only('ended_in', 'ended_at');
CREATE TRIGGER fact_append_only AFTER UPDATE OR DELETE ON fact
  FOR EACH ROW EXECUTE FUNCTION append_only('ended_in', 'ended_at');
