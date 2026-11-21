-- Agent slice B: the agent loop replaces the one-command parser.
--   command    what ran (a list of tool calls); parsed what the model asked for (null when no model ran,
--              a short answer to a question); both were one command object before.
--   action     one word for the message (log, correct, delete, summarize, ask, reply, multi), for
--              `pnpm latency`. Older rows keep their old command type there.
--   tool_calls the audit: every tool call of the loop in order, with its turn, input, outcome and ms.
--   model_turns how many model calls the message used (0: answered in code).
--   pending    what a question (`asked_ids`) will do once its option is picked: the answer path runs it.
ALTER TABLE inbound_message
  ADD COLUMN action      text,
  ADD COLUMN tool_calls  jsonb,
  ADD COLUMN model_turns smallint,
  ADD COLUMN pending     jsonb;
UPDATE inbound_message SET action = command->>'type' WHERE command IS NOT NULL;
