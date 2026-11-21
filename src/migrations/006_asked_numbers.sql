-- The numbers a "¿Cuál?" reply listed, stored with it at the commit point, so the next message of the
-- sender can answer the question ("2", "el primero") without trusting the model to notice it was one.
ALTER TABLE inbound_message ADD COLUMN asked_numbers integer[];
