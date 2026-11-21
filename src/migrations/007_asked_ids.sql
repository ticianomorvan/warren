-- A "¿Cuál?" reply now stores the movement ids it offered next to the numbers it showed: the list can
-- shift between the question and its answer (a log in between, a re-queue), the ids cannot.
-- `parsed` keeps what the model returned; `command` is what code ran (the same, unless a short answer
-- ran the previous command on a picked movement).
ALTER TABLE inbound_message
  ADD COLUMN asked_ids bigint[],
  ADD COLUMN parsed    jsonb;
UPDATE inbound_message SET parsed = command WHERE command IS NOT NULL;
