-- The done mark (a reaction after the reply) was removed: the reply already confirms the message.
ALTER TABLE inbound_message DROP COLUMN reaction_sent_at;
