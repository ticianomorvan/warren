# Slice 6: reminders over WhatsApp

Status: draft for Ticiano's read, 2026-11-22. Builds on `docs/agent-spec.md` (slice G), `AGENTS.md`.

## Goal

The person says "recordame pagar la Visa el 10" or "todos los meses el 5 avisame del alquiler".
Warren confirms the exact day and time, and at that time sends "⏰ Recordatorio: pagar la Visa".
The person can list ("¿qué recordatorios tengo?"), cancel ("cancelá el del alquiler"), undo
("deshacer"), and stop all of them with "BAJA".

Done means:

- Live: "recordame en 2 minutos tomar agua" arrives 2 minutes later as text; the template
  `warren_recordatorio` arrives on Ticiano's number when sent outside the 24 h window.
- A reminder is sent at most once per occurrence, even across a restart or a deploy mid-send.
- A missed occurrence (server down) is sent late with "(era para …)", never dropped silently.
- `pnpm test` and `pnpm eval:scenarios` hold their bars (≥95%, 0 silent wrong changes, 0 invented
  numbers), with new reminder scenarios.

## Not doing

- Warren-initiated nudges (weekly summary, "no anotaste nada hoy"): those need opt-in design and
  may be judged marketing by Meta.
- Due dates read from card statements, snooze, quick-reply buttons on the template.
- Recurrence beyond one-off and monthly (see Open questions); free-form rules (RRULE).
- MCP tools for reminders: one `registerTool` each over the same `applyCall`, after the overhaul.

## What exists

- Sending: `src/whatsapp/graph.ts` `Graph.sendText`, private `post` to
  `/{phone-number-id}/messages`, `GraphError` with `notSent`/`retryable`. No template send yet.
- At-most-once replies: `src/process.ts` commits `send_started_at` before the send; 5xx or timeout
  ends `unknown` and is never resent. Reminders copy this rule.
- Tick: `src/server.ts:70-75` runs `processor.sweep()` every 30 s on one replica.
- Nothing computes Meta's 24 h window. (`CONVERSATION_WINDOW_MS` in `src/store.ts` is model context.)
- Closest analogue: memory facts. `011_facts.sql` (append-only, `superseded_by`/`restores`),
  `src/facts.ts`, guards in `src/agent/memory.ts` (secret check), `apply.ts` cases, renderers in
  `render.ts:306-345`, `src/undo-facts.ts`, and facts shown in the per-message context.
- Movement dates must not be in the future (`src/agent/validate.ts:24-28`); reminders need the
  opposite rule. Time helpers in `src/time.ts` (Argentina is UTC-3 with no DST).
- Typed commands without the model: `src/resolve.ts` (`undoRequest`, `disconnectRequest`).
- `.env` and Railway have `WHATSAPP_BUSINESS_ACCOUNT_ID`; the token has
  `whatsapp_business_management`, and listing templates works (only Meta's samples exist).
- Phone number: test number, quality GREEN, `TIER_250` (250 unique people a day outside a window).

## Cost (Meta rate card effective 2026-10-01, Argentina)

| Message | USD | ARS at BNA 1,600 / MEP 1,743 |
|---|---|---|
| Utility template (any time) | 0.026 | 41.6 / 45.3 |
| Free-form text inside the 24 h window | first 1,000 a month free per number, then 0.026 | 0 / 41.6–45.3 |
| Marketing template (if Meta re-categorizes) | 0.0618 | 98.9 / 107.7 |

Since 2026-10-01 a utility template inside the window is billed too, and free-form replies are free
only for the first 1,000 a month per number. This also applies to Warren's ordinary replies
(about 100 so far in total, so free today). So: free-form text when the window is open, the template
only when it is closed. Caps keep a bug from spending: 10 reminder sends per person per day,
200 per day overall (worst case US$5.20 a day, about ARS 8,300).

## Design

1. **Data** (`014_reminders.sql`).
   - `reminder`: `account_id`, `what` (≤100 chars, one line), `repeat` (`none` | `monthly`),
     `day_of_month` (monthly, 1–31, clamped to the month's last day), `local_time`,
     `next_due_at` (timestamptz), `inbound_message_id` (the batch that made it), `cancelled_at`,
     `cancelled_by`, `restores`.
     Append-only like `fact`: a restore inserts a new row.
   - `reminder_send`: `reminder_id`, `due_at`, `kind` (`text` | `template`), `started_at`,
     `wamid`, `status` (`started` | `sent` | `failed` | `unknown` | `capped`), `error_code`.
     `unique(reminder_id, due_at)` is the at-most-once guard, and the daily caps count this table.
2. **Agent tools** (terminal, rendered by code, like facts).
   - `set_reminder {what, date, time?, repeat}`: `date` is `yyyy-mm-dd` and `time` is `HH:MM`
     local, default 09:00. Guards in code: in the future, at most 366 days out, `what` passes the
     memory secret check (it leaves through Meta), at most 20 live reminders.
     Reply: "⏰ Te aviso el miércoles 10/12 a las 09:00: pagar la Visa."
   - `cancel_reminder {id}`, `list_reminders {}`. Live reminders (id, what, next date) go in the
     per-message context, so "cancelá el del alquiler" resolves like a fact.
   - Prompt: for a reminder, "el 10" means the next 10th (the movement rule is the opposite).
3. **BAJA** is a typed command in `resolve.ts`, handled without the model (Meta's policy requires
   honouring opt-out). It cancels every live reminder in one batch. The reply says how many, and
   "deshacer" restores them. Setting a new reminder later is a new opt-in.
4. **Undo**: `src/undo-reminders.ts`, modelled on `undo-facts.ts`. Undoing a set cancels the
   reminder; undoing a cancel or BAJA restores it. `stale` if a one-off has already fired.
   `ledger.ts` batch rule gains "set or cancelled a reminder".
5. **Sender** (`src/reminders/send.ts`), called from the existing 30 s tick.
   - Claim, in one transaction: rows with `next_due_at <= now`, `for update skip locked`,
     limit 20. Insert `reminder_send` (`on conflict do nothing`) and advance `next_due_at`
     (monthly) or mark the reminder fired (one-off). Commit, then send. A 5xx or timeout leaves the
     send `unknown`, never resent.
   - Window: the newest `channel='whatsapp'` inbound from that person less than 23 h 50 m ago means
     text ("⏰ Recordatorio: …"). Otherwise, or on error 131047, send the template (both are 4xx
     not-sent cases, so the fallback cannot double-send).
   - More than 15 minutes late adds "(era para el 10/12 a las 09:00)".
   - Over a cap: status `capped`, an `alert` log, nothing sent.
   - Status webhooks: a `failed` status for a reminder wamid updates `reminder_send` and logs.
     Today `process.ts` ignores statuses.
6. **Template** `warren_recordatorio`, UTILITY, `es_AR`. Body: "Recordatorio que pediste en
   Warren: {{1}}. Para dejar de recibir recordatorios, respondé BAJA." A template must not start or
   end with a variable; `{{1}}` is `what`, single line. `pnpm template:create` submits it once
   through `/{WABA_ID}/message_templates` and prints the returned `category` and `status`.
   If Meta files it as MARKETING, stop and ask: the price more than doubles and marketing limits
   (131049) apply. Config: `REMINDER_TEMPLATE` (name; unset means `set_reminder` refuses with
   "todavía no puedo mandar recordatorios").

Rejected:

- **A Railway cron service or a separate worker:** a second deploy unit for a tick we already run.
- **pg-boss, BullMQ or pg_cron:** a dependency or an extension, for at most hundreds of rows.
- **Always sending the template:** it pays for every send, and free-form text inside the window
  gets the 1,000 free.
- **Writing the reminder text with the model at fire time:** no model call when sending; the text
  is fixed when the reminder is set.

From scratch today, this is still the shape: one table, one claim, one tick.

## Slices

1. **Send path, no agent.** The migration, `reminders/send.ts`, `Graph.sendTemplate`, the caps,
   the status webhook, and `pnpm template:create`.
   Proof:
   - Tests with the fake Graph: window open gives text; closed gives the template; 131047 falls back
     to the template; a 5xx is `unknown` and not resent; a second sweep or a restart sends nothing
     twice; monthly advances, and day 31 lands on Feb 28; caps hold.
   - Live: a script inserts a reminder for Ticiano 2 minutes out and it arrives as text;
     `pnpm reminder:try-template` sends the template once to his number and it arrives.
2. **Agent, BAJA, undo.** The three tools, guards, context, renderers, help line, prompt lines,
   BAJA, undo.
   Proof:
   - `pnpm test`, plus new scenarios: one-off; monthly; "el 10" means the next one; a past time is
     refused; cancel by name; list; BAJA then deshacer; a secret in `what` is refused.
   - `pnpm eval:scenarios` at its bars.
   - Live: "recordame en 2 minutos tomar agua" arrives.

## Open questions

1. Is one-off plus monthly enough, or should weekly ("todos los lunes") ship too? Weekly is a small
   addition.
2. May I submit `warren_recordatorio` to Meta? The permission check blocked me. Meta reviews it
   (up to 24 h) and it can be deleted. Either allow it, or create it yourself in WhatsApp Manager
   with the body above.
3. Payment method: Meta says the test number sends free messages to up to 5 recipients, but I could
   not confirm that templates go out without a card on the account. If sends fail with 131042,
   add one in Billing Hub.
4. Default time when none is given: 09:00? Caps: 20 live reminders a person, 10 sends a person
   a day, 200 a day overall. Fine?
