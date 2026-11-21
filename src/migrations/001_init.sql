-- Slice 2: the inbound message, with a timestamp per stage, and the reply it got.
-- Slice 3 adds "user" and "movement" and a nullable inbound_message.user_id; nothing here changes.

CREATE TABLE inbound_message (
  id              bigserial PRIMARY KEY,
  wamid           text        NOT NULL UNIQUE,
  wa_id           text        NOT NULL,
  kind            text        NOT NULL,                -- WhatsApp message type: text, image, ...
  body            text,                                -- text body, when kind = 'text'
  payload         jsonb       NOT NULL,                -- the raw message object
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'ignored')),
  attempts        integer     NOT NULL DEFAULT 0,
  meta_ts         timestamptz,                         -- message timestamp from the payload (seconds)
  received_at     timestamptz NOT NULL,
  claimed_at      timestamptz,                         -- last time a worker took the row
  typing_sent_at  timestamptz,
  reply_sent_at   timestamptz,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_message_open_idx ON inbound_message (status, updated_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX inbound_message_received_idx ON inbound_message (received_at DESC);

CREATE TABLE reply (
  id              bigserial PRIMARY KEY,
  outbound_wamid  text        NOT NULL UNIQUE,
  inbound_wamid   text        REFERENCES inbound_message (wamid),  -- null if a status beat the insert
  sent_at         timestamptz,
  delivered_at    timestamptz,                         -- from status webhooks (seconds)
  read_at         timestamptz,
  failed_at       timestamptz
);

CREATE INDEX reply_inbound_idx ON reply (inbound_wamid);
