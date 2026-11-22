-- Slice 5.3: Warren over MCP can write (docs/mcp-spec.md, Design 4), and a person can cut the connection.
--
-- inbound_message.channel
--   An MCP write is recorded as a settled `inbound_message` row (`channel = 'mcp'`, `wamid = 'mcp:<request id>'`, the account's
--   wa_id, `action`, a `reply_text` summary), so that the movement and fact rows have their batch to point at and an undo, from
--   either channel, sees it unchanged. Everything that assumes a row is a WhatsApp message (the claim and the sweep, the
--   conversation window and the question to answer, the latency report) reads only `channel = 'whatsapp'`; the undo does not.
--   `payload` of an MCP row holds the result the client was given, which is what a retried request gets back.
-- account.mcp_revoked_at
--   "desconectar" on WhatsApp sets it: the door of /mcp refuses every access token issued at or before it, so a live token
--   stops working on its next call (refresh tokens and consents are removed in the same transaction).
ALTER TABLE inbound_message
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'mcp'));

ALTER TABLE account ADD COLUMN mcp_revoked_at timestamptz;
