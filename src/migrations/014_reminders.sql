-- Slice 6.1 (docs/reminders-spec.md, Design 1): reminders over WhatsApp.
--
-- reminder
--   One row per reminder, append-only like `fact`: a cancel stamps `cancelled_at` and `cancelled_by`; an undo of a cancel
--   inserts a new row (`restores` names the cancelled one). `schedule` is the typed schedule (src/reminders/schedule.ts)
--   and `next_due_at` the next occurrence, null once it is finished. Only the sender moves `next_due_at` and `sent_count`.
--   `inbound_message_id` is the batch that made it; null for a reminder made by the `pnpm reminder:add` dev helper.
-- reminder_send
--   One row per occurrence, inserted (and committed) before anything is sent: `unique (reminder_id, due_at)` is the
--   at-most-once guard, and the daily cap counts this table. `started` that never ends becomes `unknown` and is never resent.
CREATE TABLE reminder (
  id                  bigserial   PRIMARY KEY,
  account_id          bigint      NOT NULL REFERENCES account (id),
  what                text        NOT NULL CHECK (what <> '' AND char_length(what) <= 100 AND what !~ '[[:cntrl:]]'),
  schedule            jsonb       NOT NULL,
  next_due_at         timestamptz,
  sent_count          integer     NOT NULL DEFAULT 0,
  inbound_message_id  bigint      REFERENCES inbound_message (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_at        timestamptz,
  cancelled_by        bigint      REFERENCES inbound_message (id),
  restores            bigint      REFERENCES reminder (id),
  CONSTRAINT reminder_cancelled_pair CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);

-- What the sweep reads: live reminders that are due.
CREATE INDEX reminder_due_idx ON reminder (next_due_at)
  WHERE next_due_at IS NOT NULL AND cancelled_at IS NULL;
CREATE INDEX reminder_account_idx ON reminder (account_id, id DESC) WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX reminder_restores_idx ON reminder (restores) WHERE restores IS NOT NULL;
CREATE INDEX reminder_inbound_idx ON reminder (inbound_message_id) WHERE inbound_message_id IS NOT NULL;
CREATE INDEX reminder_cancelled_by_idx ON reminder (cancelled_by) WHERE cancelled_by IS NOT NULL;

CREATE TABLE reminder_send (
  id           bigserial   PRIMARY KEY,
  reminder_id  bigint      NOT NULL REFERENCES reminder (id),
  due_at       timestamptz NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('text', 'template')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  wamid        text,
  status       text        NOT NULL CHECK (status IN ('started', 'sent', 'failed', 'unknown', 'capped')),
  error_code   integer,
  CONSTRAINT reminder_send_once UNIQUE (reminder_id, due_at)
);

CREATE INDEX reminder_send_started_idx ON reminder_send (started_at DESC);
CREATE INDEX reminder_send_wamid_idx ON reminder_send (wamid) WHERE wamid IS NOT NULL;

-- The 24 h window: the sender asks for a person's newest WhatsApp message.
CREATE INDEX inbound_message_window_idx ON inbound_message (wa_id, received_at DESC)
  WHERE channel = 'whatsapp';
