-- Warren's schema, as it would be written today (docs/rebuild-spec.md, "1. Data"; decisions D0-D16 in docs/rebuild/decisions-core.md).
-- One file, no superseded steps. Every column, constraint and index is named on purpose, and every table says what a row is.
--
-- The shape in four sentences:
--   * `turn` is the commit point: one row per committed unit of work, inserted only inside the commit transaction.
--   * `movement`, `fact` and `reminder` are versioned: a change inserts a new version of the same entity and ends the old one.
--   * The person's data is append-only (`append_only()` below): only `ended_in`/`ended_at` (once) and `reminder.next_due_at` change.
--   * `wa_message` and its sinks are transport state: they change as a message moves through the worker.

-- ---------------------------------------------------------------------------------------------------------------------
-- The person

CREATE TABLE account (
  id              bigserial   PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- "desconectar" sets it: the MCP door refuses every access token issued at or before it.
  mcp_revoked_at  timestamptz
);
COMMENT ON TABLE account IS 'One row per person. Every write transaction first locks it (SELECT 1 FROM account WHERE id = $1 FOR NO KEY UPDATE), the one lock of the person''s data.';

CREATE TABLE account_address (
  account_id  bigint      NOT NULL REFERENCES account (id),
  channel     text        NOT NULL CONSTRAINT account_address_channel_known CHECK (channel IN ('whatsapp')),
  address     text        NOT NULL CONSTRAINT account_address_not_empty CHECK (address <> ''),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- An address belongs to one person: a second account cannot claim a WhatsApp number.
  CONSTRAINT account_address_one_owner PRIMARY KEY (channel, address)
);
CREATE INDEX account_address_account_idx ON account_address (account_id);
COMMENT ON TABLE account_address IS 'One row per way a person is reached on a chat channel (a WhatsApp id). The only place a wa_id lives as an owner.';

-- ---------------------------------------------------------------------------------------------------------------------
-- The commit point

CREATE TABLE turn (
  id          bigserial   PRIMARY KEY,
  account_id  bigint      NOT NULL REFERENCES account (id),
  channel     text        NOT NULL CONSTRAINT turn_channel_known CHECK (channel IN ('whatsapp', 'mcp', 'cli')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  label       text        NOT NULL CONSTRAINT turn_label_not_empty CHECK (label <> ''),  -- one word for the unit: log, correct, undo, multi...
  calls       jsonb       NOT NULL DEFAULT '[]' CONSTRAINT turn_calls_array CHECK (jsonb_typeof(calls) = 'array'),  -- the tool calls and their outcomes (scrubbed of a secret's inputs)
  record      text,                                    -- what code rendered for the changes; null when nothing was changed
  reply       text        NOT NULL,                    -- the whole reply the person got
  -- A "which one?" the reply asked: {options: [{n, id}], then}. The person's next message answers it.
  question    jsonb       CONSTRAINT turn_question_object CHECK (question IS NULL OR jsonb_typeof(question) = 'object'),
  undoes      bigint      REFERENCES turn (id),        -- the turn this one reverted
  CONSTRAINT turn_undoes_other CHECK (undoes IS NULL OR undoes <> id)
);
-- A turn is undone once, whatever races.
CREATE UNIQUE INDEX turn_undoes_once ON turn (undoes) WHERE undoes IS NOT NULL;
-- The person's newest turns (the undo's "last turn", the conversation window); undo order is commit order, which is id order.
CREATE INDEX turn_account_idx ON turn (account_id, id DESC);
COMMENT ON TABLE turn IS 'One row per committed unit of work, on any channel. It is inserted only in the commit transaction, so its existence is the commit point; it is never updated.';

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
-- WhatsApp transport

CREATE TABLE wa_message (
  id               bigserial   PRIMARY KEY,
  -- identity
  wamid            text        NOT NULL CONSTRAINT wa_message_wamid_unique UNIQUE,
  wa_id            text        NOT NULL,
  kind             text        NOT NULL CONSTRAINT wa_message_kind_not_empty CHECK (kind <> ''),   -- WhatsApp message type: text, image, audio...
  text             text,                                -- the text, a photo's caption, or a voice note's transcript; a secret leaves a placeholder
  media_id         text,                                -- a photo's or voice note's media id, to download it (the bytes are never stored)
  meta_ts          timestamptz,                         -- the timestamp Meta put on the message
  received_at      timestamptz NOT NULL DEFAULT now(),
  context_wamid    text,                                -- the message this one replied to
  -- queue and send state
  status           text        NOT NULL DEFAULT 'pending'
                   CONSTRAINT wa_message_status_known CHECK (status IN ('pending', 'processing', 'done', 'failed', 'ignored', 'unknown')),
  attempts         integer     NOT NULL DEFAULT 0 CONSTRAINT wa_message_attempts_not_negative CHECK (attempts >= 0),
  claimed_at       timestamptz,
  typing_sent_at   timestamptz,
  interim_sent_at  timestamptz,
  failure_sent_at  timestamptz,
  send_started_at  timestamptz,                         -- committed before the Graph call: a row that died after it is never sent again
  reply_sent_at    timestamptz,
  error            text,
  -- trace
  turn_id          bigint      CONSTRAINT wa_message_turn_once UNIQUE REFERENCES turn (id),
  audit            jsonb,                               -- every tool call of the agent loop, in order
  timings          jsonb                                -- per-stage times (claim, reads, each model turn, commit, send)
);
-- A sender's open rows in order: the claim takes the oldest in the lane, and the sweep finds senders with work.
CREATE INDEX wa_message_open_idx ON wa_message (wa_id, id) WHERE status IN ('pending', 'processing');
-- The 24 h window and the conversation: a sender's newest messages.
CREATE INDEX wa_message_sender_idx ON wa_message (wa_id, received_at DESC);
CREATE INDEX wa_message_received_idx ON wa_message (received_at DESC);
COMMENT ON TABLE wa_message IS 'One row per WhatsApp message received: its identity, its place in the worker''s queue, the markers of what was sent for it, and its trace. It stores no raw payload.';

CREATE TABLE reply (
  id              bigserial   PRIMARY KEY,
  outbound_wamid  text        NOT NULL CONSTRAINT reply_outbound_wamid_unique UNIQUE,
  wa_message_id   bigint      REFERENCES wa_message (id),   -- null if a status beat the insert
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_at       timestamptz
);
CREATE INDEX reply_wa_message_idx ON reply (wa_message_id);
COMMENT ON TABLE reply IS 'One row per message Warren sent as an answer, with the delivery statuses Meta reported for it. A status sink: it is updated as webhooks arrive.';

-- ---------------------------------------------------------------------------------------------------------------------
-- Versioned stores. The shared columns of movement, fact and reminder:
--   entity_id  the same across every version of a thing; the model and MCP clients see this id.
--   made_in    the turn that inserted this version.
--   ended_in / ended_at   the turn that ended this version (a correction, a delete, a forget, a cancel, an undo) and when.
--              Live means ended_at IS NULL. Both are set together, once.
-- A correction inserts a new version of the same entity_id in the same transaction that ends the old one.

CREATE SEQUENCE movement_entity_seq AS bigint;
CREATE TABLE movement (
  id           bigserial   PRIMARY KEY,
  entity_id    bigint      NOT NULL DEFAULT nextval('movement_entity_seq'),
  account_id   bigint      NOT NULL REFERENCES account (id),
  made_in      bigint      NOT NULL REFERENCES turn (id),
  ended_in     bigint      REFERENCES turn (id),
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
  CONSTRAINT movement_ended_pair CHECK ((ended_at IS NULL) = (ended_in IS NULL))
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
  made_in     bigint      NOT NULL REFERENCES turn (id),
  ended_in    bigint      REFERENCES turn (id),
  ended_at    timestamptz,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  kind        text        NOT NULL CONSTRAINT fact_kind_known CHECK (kind IN ('alias', 'category', 'note')),
  key         text        NOT NULL CONSTRAINT fact_key_length CHECK (key <> '' AND char_length(key) <= 40),     -- normalized words the fact is about
  value       text        NOT NULL CONSTRAINT fact_value_length CHECK (value <> '' AND char_length(value) <= 100),
  CONSTRAINT fact_ended_pair CHECK ((ended_at IS NULL) = (ended_in IS NULL))
);
ALTER SEQUENCE fact_entity_seq OWNED BY fact.entity_id;
CREATE UNIQUE INDEX fact_one_live_version ON fact (entity_id) WHERE ended_at IS NULL;
-- One live fact per account, kind and key: a race cannot make two.
CREATE UNIQUE INDEX fact_one_live_key ON fact (account_id, kind, key) WHERE ended_at IS NULL;
CREATE INDEX fact_live_idx ON fact (account_id, id DESC) WHERE ended_at IS NULL;
CREATE INDEX fact_made_in_idx ON fact (made_in);
CREATE INDEX fact_ended_in_idx ON fact (ended_in) WHERE ended_in IS NOT NULL;
COMMENT ON TABLE fact IS 'One row per version of something the person told Warren to remember (an alias, a category rule or a note), in their words. A new value or a forget ends the version; only the ended pair ever changes.';

CREATE SEQUENCE reminder_entity_seq AS bigint;
CREATE TABLE reminder (
  id           bigserial   PRIMARY KEY,
  entity_id    bigint      NOT NULL DEFAULT nextval('reminder_entity_seq'),
  account_id   bigint      NOT NULL REFERENCES account (id),
  made_in      bigint      NOT NULL REFERENCES turn (id),
  ended_in     bigint      REFERENCES turn (id),
  ended_at     timestamptz,
  logged_at    timestamptz NOT NULL DEFAULT now(),
  what         text        NOT NULL CONSTRAINT reminder_what_valid
               CHECK (what <> '' AND char_length(what) <= 100 AND what !~ '[[:cntrl:]]'),
  schedule     jsonb       NOT NULL CONSTRAINT reminder_schedule_object CHECK (jsonb_typeof(schedule) = 'object'),  -- the typed schedule (src/domain/reminders/schedule.ts)
  -- Declared mutable scheduler state, the one column besides the ended pair that changes in place: the next occurrence, null once finished.
  next_due_at  timestamptz,
  CONSTRAINT reminder_ended_pair CHECK ((ended_at IS NULL) = (ended_in IS NULL))
);
ALTER SEQUENCE reminder_entity_seq OWNED BY reminder.entity_id;
CREATE UNIQUE INDEX reminder_one_live_version ON reminder (entity_id) WHERE ended_at IS NULL;
-- What the sweep reads: live reminders that are due.
CREATE INDEX reminder_due_idx ON reminder (next_due_at) WHERE next_due_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX reminder_live_idx ON reminder (account_id, id DESC) WHERE ended_at IS NULL;
CREATE INDEX reminder_made_in_idx ON reminder (made_in);
CREATE INDEX reminder_ended_in_idx ON reminder (ended_in) WHERE ended_in IS NOT NULL;
COMMENT ON TABLE reminder IS 'One row per version of a reminder the person set. A cancel ends the version; only the ended pair and next_due_at (the scheduler''s own state) ever change.';

CREATE TABLE reminder_send (
  id                 bigserial   PRIMARY KEY,
  account_id         bigint      NOT NULL REFERENCES account (id),  -- the daily cap counts a person's sends
  -- The reminder's entity_id, not a version's id: a send belongs to the reminder across its versions. No foreign key: entity_id is not unique in `reminder`.
  reminder_entity_id bigint      NOT NULL,
  due_at             timestamptz NOT NULL,
  kind               text        NOT NULL CONSTRAINT reminder_send_kind_known CHECK (kind IN ('text', 'template')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  wamid              text,
  status             text        NOT NULL CONSTRAINT reminder_send_status_known
                     CHECK (status IN ('started', 'sent', 'failed', 'unknown', 'capped', 'retry_template')),
  error_code         integer,
  -- At most once per occurrence: the row is inserted (and committed) before anything is sent.
  CONSTRAINT reminder_send_once UNIQUE (reminder_entity_id, due_at)
);
CREATE INDEX reminder_send_account_idx ON reminder_send (account_id, started_at DESC);
CREATE INDEX reminder_send_wamid_idx ON reminder_send (wamid) WHERE wamid IS NOT NULL;
-- Meta's 131047 arrives as a failed status after a 200: the sweep claims these once and sends the template.
CREATE INDEX reminder_send_retry_idx ON reminder_send (id) WHERE status = 'retry_template';
COMMENT ON TABLE reminder_send IS 'One row per occurrence of a reminder that was sent or attempted, inserted before the send: its unique key is the at-most-once guard, and the daily cap counts it. A status sink.';

-- ---------------------------------------------------------------------------------------------------------------------
-- Append-only guard. Attached to every table of the person's data; the arguments are the columns that may change in place.
--   * no DELETE;
--   * an UPDATE may touch only the listed columns;
--   * `ended_in`/`ended_at` change once: from NULL, together (the table's *_ended_pair CHECK keeps them together).
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
CREATE TRIGGER reminder_append_only AFTER UPDATE OR DELETE ON reminder
  FOR EACH ROW EXECUTE FUNCTION append_only('ended_in', 'ended_at', 'next_due_at');
