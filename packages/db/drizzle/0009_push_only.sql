DROP POLICY "notice_status_select" ON "notice_status" CASCADE;--> statement-breakpoint
DROP POLICY "notice_status_insert" ON "notice_status" CASCADE;--> statement-breakpoint
DROP TABLE "notice_status" CASCADE;--> statement-breakpoint
-- Hand-written, as in 0005. The former WhatsApp notifier is gone, with what served its status
-- webhook: the lookup by message id and its index. Dropping notice_status takes its triggers,
-- policies and grants with it. notice_attempt keeps its old rows and its nullable wamid column
-- (append-only history, dropping it buys nothing), and the mode check still allows 'text' and
-- 'template' for those rows; nothing writes them any more.
drop function user_for_wamid(text);--> statement-breakpoint
drop index notice_attempt_wamid_ix;
