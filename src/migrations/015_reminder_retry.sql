-- Slice 6.1, review: Meta usually reports 131047 ("more than 24 hours since the person wrote") as a `failed` status
-- webhook after a 200, not as an error on the send. The row of a text send that got it becomes `retry_template`: the
-- sweep claims it once (-> `started`, `kind = 'template'`) and sends the template, so the reminder is not lost.
ALTER TABLE reminder_send DROP CONSTRAINT reminder_send_status_check;
ALTER TABLE reminder_send ADD CONSTRAINT reminder_send_status_check
  CHECK (status IN ('started', 'sent', 'failed', 'unknown', 'capped', 'retry_template'));
CREATE INDEX reminder_send_retry_idx ON reminder_send (id) WHERE status = 'retry_template';
