-- Slice 3: accounts, movements, and what the logging flow records on the message.

CREATE TABLE account (
  id          bigserial PRIMARY KEY,
  wa_id       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inbound_message
  ADD COLUMN command           jsonb,           -- the parsed command, stored at the commit point
  ADD COLUMN reply_text        text,            -- the rendered reply, stored at the commit point
  ADD COLUMN model_ms          integer,         -- time spent in parseMessage
  ADD COLUMN interim_sent_at   timestamptz,     -- committed before the "sigo con esto" note is sent
  ADD COLUMN failure_sent_at   timestamptz,     -- committed before the failure notice is sent
  ADD COLUMN reaction_sent_at  timestamptz;     -- committed before the done mark is sent

CREATE TABLE movement (
  id                  bigserial PRIMARY KEY,
  account_id          bigint      NOT NULL REFERENCES account (id),
  inbound_message_id  bigint      NOT NULL REFERENCES inbound_message (id),
  position            integer     NOT NULL CHECK (position >= 0),  -- index within the message
  direction           text        NOT NULL CHECK (direction IN ('in', 'out')),
  amount              numeric     NOT NULL CHECK (amount > 0),
  currency            text        NOT NULL CHECK (currency IN ('ARS', 'USD')),
  occurred_on         date        NOT NULL,                        -- the Argentine calendar day
  description         text        NOT NULL,
  category            text        NOT NULL,
  payment             text,
  confidence          text        NOT NULL CHECK (confidence IN ('high', 'low')),
  superseded_by       bigint      REFERENCES movement (id),        -- unused until slice 4
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbound_message_id, position)
);

CREATE INDEX movement_account_idx ON movement (account_id, id DESC) WHERE superseded_by IS NULL;
