# Slice 6: reminders over WhatsApp

Status: approved by Ticiano 2026-11-22 (any periodicity, English template names, no global cap). Builds on `docs/agent-spec.md` (slice G), `AGENTS.md`.

## Goal

The person says "recordame pagar la Visa el 10", "todos los meses el 5 avisame del alquiler" or
"los lunes y jueves recordame la pastilla" (any periodicity).
Warren confirms the exact day and time, and at that time sends "⏰ Recordatorio: pagar la Visa".
The person can list ("¿qué recordatorios tengo?"), cancel ("cancelá el del alquiler"), undo
("deshacer"), and stop them all by asking ("cancelá todos los recordatorios").

Done means:

- Live: "recordame en 2 minutos tomar agua" arrives 2 minutes later as text; the template
  `warren_reminder` arrives on Ticiano's number when sent outside the 24 h window.
- A reminder is sent at most once per occurrence, even across a restart or a deploy mid-send.
- A missed occurrence (server down) is sent late with "(era para …)", never dropped silently.
- `pnpm test` and `pnpm eval:scenarios` hold their bars (≥95%, 0 silent wrong changes, 0 invented
  numbers), with new reminder scenarios.

## Not doing

- Warren-initiated nudges (weekly summary, "no anotaste nada hoy"): those need opt-in design and
  may be judged marketing by Meta.
- Due dates read from card statements, snooze, quick-reply buttons on the template.
- Holiday-aware schedules ("días hábiles" means mon–fri, holidays included).
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

| Message                                     | USD                                             | ARS at BNA 1,600 / MEP 1,743 |
| ------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| Utility template (any time)                 | 0.026                                           | 41.6 / 45.3                  |
| Free-form text inside the 24 h window       | first 1,000 a month free per number, then 0.026 | 0 / 41.6–45.3                |
| Marketing template (if Meta re-categorizes) | 0.0618                                          | 98.9 / 107.7                 |

Since 2026-10-01 a utility template inside the window is billed too, and free-form replies are free
only for the first 1,000 a month per number. This also applies to Warren's ordinary replies
(about 100 so far in total, so free today). So: free-form text when the window is open, the template
only when it is closed. A per-person cap (10 sends a day, about US$0.26) keeps a bug from
spending; there is no global block, only an alert above 200 sends a day. Meta's own limit is
250 people a day outside a window at `TIER_250`.

## Design

1. **Data** (`014_reminders.sql`).
   - `reminder`: `account_id`, `what` (≤100 chars, one line), `schedule` (jsonb, below),
     `next_due_at` (timestamptz, null once finished), `sent_count`, `inbound_message_id` (the batch
     that made it), `cancelled_at`, `cancelled_by`, `restores`.
     Append-only like `fact`: a restore inserts a new row.
   - `reminder_send`: `reminder_id`, `due_at`, `kind` (`text` | `template`), `started_at`,
     `wamid`, `status` (`started` | `sent` | `failed` | `unknown` | `capped`), `error_code`.
     `unique(reminder_id, due_at)` is the at-most-once guard, and the daily cap counts this table.
2. **Schedule: any periodicity** (`src/reminders/schedule.ts`, pure).
   The shape is the useful subset of iCalendar RRULE, as typed fields instead of a rule string:
   - `start` (`yyyy-mm-dd`) and `time` (`HH:MM` local, default 09:00).
   - `every`: absent means once; otherwise `day` | `week` | `month` | `year`, with `interval`
     (1–365, default 1).
   - `weekdays` (`mon`…`sun`) for week. `month_days` (1–31, or -1 for the last day) for month and
     year. `nth` plus one weekday for month ("primer lunes", "último viernes" = -1). `month`
     (1–12) for year.
   - An optional end: `until` (date) or `count`.

   Examples: "todos los lunes y jueves", "cada 15 días", "días hábiles" (mon–fri), "el 1 y el 15",
   "el último día de cada mes", "cada 2 meses el 10", "cada 3 de abril", "3 veces".
   `nextOccurrence(schedule, after) -> Date | null` is the only logic. A day 31 in a short month
   lands on the month's last day. Property tests: always strictly after `after`, never past
   `until` or `count`, and every result matches the rule.
   Rejected: the `rrule` npm package (a new dependency with known time-zone bugs, which we don't
   need on UTC-3 with no DST), and storing a raw RRULE string the model writes (opaque to the
   guards and the renderer).
3. **Agent tools** (terminal, rendered by code, like facts).
   - `set_reminder {what, schedule}`. Guards in code: the schedule parses, the first occurrence is
     in the future and at most 366 days out, `interval` keeps at least one day between sends,
     `what` passes the memory secret check (it leaves through Meta), and at most 20 live
     reminders.
     The reply is rendered from the schedule, so the person sees what code understood:
     "⏰ Te aviso todos los lunes y jueves a las 09:00, desde el 24/11: tomar la pastilla."
   - `cancel_reminder {id}`, `list_reminders {}`. Live reminders (id, what, next date) go in the
     per-message context, so "cancelá el del alquiler" resolves like a fact.
   - Prompt: for a reminder, "el 10" means the next 10th (the movement rule is the opposite).
4. **Stopping them** is an ordinary request, not a keyword (decided 2026-11-22: the person sets every
   reminder themselves, so a magic word that bypasses the model and wipes them all does not fit).
   "Cancelá este", "cancelá el del alquiler", "cancelá todos los recordatorios" go through the model:
   one `cancel_reminder` per reminder, all in one turn (so one batch, a line each, and one "deshacer"
   restores them all). There is no BAJA command.
5. **Undo**: `src/undo-reminders.ts`, modelled on `undo-facts.ts`. Undoing a set cancels the
   reminder; undoing a cancel restores it, with `next_due_at` recomputed from now.
   `stale` if a one-off has already fired. `ledger.ts` batch rule gains "set or cancelled a
   reminder".
6. **Sender** (`src/reminders/send.ts`), called from the existing 30 s tick.
   - Claim, in one transaction: rows with `next_due_at <= now`, `for update skip locked`,
     limit 20. Insert `reminder_send` (`on conflict do nothing`) and set `next_due_at` to
     `nextOccurrence(schedule, due_at)`, or null when finished. After downtime only the latest
     missed occurrence is sent; earlier ones are skipped. Commit, then send. A 5xx or timeout
     leaves the send `unknown`, never resent.
   - Window: the newest `channel='whatsapp'` inbound from that person less than 23 h 50 m ago means
     text ("⏰ Recordatorio: …"). Otherwise, or on error 131047, send the template (both are 4xx
     not-sent cases, so the fallback cannot double-send).
   - More than 15 minutes late adds "(era para el 10/12 a las 09:00)".
   - Over the per-person cap (10 sends a day): status `capped`, an `alert` log, nothing sent for
     that person. There is no global block: more than 200 sends in a day only raises an `alert`.
   - Status webhooks: a `failed` status for a reminder wamid updates `reminder_send` and logs.
     Today `process.ts` ignores statuses.
7. **Template** `warren_reminder` (code names are English), UTILITY, `es_AR`. Submitted
   2026-11-22, id 987826090606776. Meta returned category UTILITY, status PENDING.
   Body: "Recordatorio que pediste en Warren: {{1}}. Si ya no lo necesitás, decime y lo cancelo."
   A template must not start or end with a variable; `{{1}}` is `what`, one line.
   `pnpm template:status` prints its `category` and `status`. If Meta re-files it as MARKETING,
   stop and ask: the price more than doubles and marketing limits (131049) apply.
   Config: `REMINDER_TEMPLATE` (name). When it is unset, `set_reminder` still works (decided 2026-11-22, so the
   feature does not wait for Meta's approval): the sender sends text inside the window, and a send that needs the
   template ends `failed` and is logged.

Rejected:

- **A Railway cron service or a separate worker:** a second deploy unit for a tick we already run.
- **pg-boss, BullMQ or pg_cron:** a dependency or an extension, for at most hundreds of rows.
- **Always sending the template:** it pays for every send, and free-form text inside the window
  gets the 1,000 free.
- **Writing the reminder text with the model at fire time:** no model call when sending; the text
  is fixed when the reminder is set.

From scratch today, this is still the shape: one table, one claim, one tick.

## Slices

1. **Schedule and send path, no agent.** The migration, `reminders/schedule.ts`,
   `reminders/send.ts`, `Graph.sendTemplate`, the cap, the status webhook, `pnpm template:status`.
   Proof:
   - Tests with the fake Graph: window open gives text; closed gives the template; 131047 falls back
     to the template; a 5xx is `unknown` and not resent; a second sweep or a restart sends nothing
     twice; the cap holds.
   - `schedule.ts` table tests for every example in Design 2, plus property tests; day 31 lands
     on Feb 28; after downtime only the latest occurrence is sent.
   - Live: a script inserts a reminder for Ticiano 2 minutes out and it arrives as text;
     once approved, `pnpm reminder:try-template` sends it once to his number and it arrives.
2. **Agent, undo.** The three tools, guards, context, renderers, help line, prompt lines,
   undo.
   Proof:
   - `pnpm test`, plus new scenarios: one-off; monthly; weekly on two days; every 15 days; last day of the
     month; "el 10" means the next one; a past time is
     refused; cancel by name; list; cancel all then deshacer; a secret in `what` is refused.
   - `pnpm eval:scenarios` at its bars.
   - Live: "recordame en 2 minutos tomar agua" arrives.

## Decisions (Ticiano, 2026-11-22)

1. Any periodicity the person asks for, not just one-off and monthly.
2. Template code names in English; the agent may create the template (done: `warren_reminder`).
3. If templates fail with 131042, Ticiano adds a payment method in Billing Hub.
4. Default time 09:00; 20 live reminders and 10 sends a day per person; no global block.

## As built: slice 1 (2026-11-22)

What shipped, and where it differs from the text above.

- `014_reminders.sql`, `src/reminders/{schedule,send,db,cli}.ts`, `Graph.sendTemplate`, `REMINDER_TEMPLATE`, the status webhook, three scripts
  (`template:status`, `reminder:try-template`, `reminder:add`). The tick runs the reminder sweep next to the message sweep.
- `reminder.inbound_message_id` is nullable: a reminder made by `pnpm reminder:add` has no batch. Slice 2 sets it on every agent-made one.
- `schedule.ts`: `nth` is `{n, weekday}` (n in 1–4 or -1) and only for `every: month`; `month_days` and `nth` are exclusive; an end with `until`
  and `count` together is allowed (the first to be reached ends it). A monthly schedule with no day, and a yearly one with no `month_days`, use the
  day of `start` (31 and 29 February clamp). `count` counts from `start`, skipped occurrences included. Periods are searched from `start` on every
  call (at most 20,000), which for a daily schedule over years is a few thousand iterations a claim.
- The per-person cap counts `reminder_send` rows in a rolling 24 h with status `started`, `sent` or `unknown` (a `failed` send cost nothing and a `capped`
  one was not sent); the daily alert counts the same over all people and fires once, when a claim crosses 200.
- Window and cap are decided inside the claim transaction. A `started` row older than 10 minutes becomes `unknown` at the start of each sweep.
- A 4xx that is not 131047 (for example a paused template) ends the send `failed`; it is not retried: the occurrence is spent. A rate-limit 4xx (130429)
  is the same today. Revisit if it shows up in the logs.
- The late note goes inside the template's one parameter ("pagar la Visa (era para el 10/12 a las 09:00)"), so it stays one line.
- Status webhooks: `store.recordStatus` first looks the wamid up in `reminder_send`; a reminder's wamid never creates a `reply` row. A status that arrives
  before the sender has stored the wamid (milliseconds) falls through to `reply`; accepted.
- Not run here, by design: `template:status` and `reminder:try-template` (the live checks are the owner's agent's, after deploy).

### Changes after review (same slice)

- **131047 is mostly asynchronous.** Meta accepts the text (200) and later sends a `failed` status with 131047. `recordReminderStatus` now turns a
  `kind='text'` row that is `sent` into `retry_template` (one guarded transaction; a redelivered webhook finds it no longer `sent` and does nothing) and
  takes it out of `sent_count`; the sweep claims `retry_template` rows before due reminders, flips them to `started` as a template in the claim
  transaction (at most once) and sends the template, under the same allow-list, per-person cap and unset-template rules. The synchronous 4xx path
  still falls back at once. Migration `015_reminder_retry.sql` adds the status.
- **Window:** measured from `COALESCE(meta_ts, received_at)` of the person's newest WhatsApp message (Meta redelivers after an outage, so `received_at` lags), and
  text only if that is under 23 h old (was 23 h 50 m).
- **`ALLOWED_WA_IDS`:** the sender takes the same list as the replies; an account no longer allowed has the occurrence spent as `failed` (logged), nothing sent.
- **One reminder per claim transaction**, up to 20 a tick; `stop(timeoutMs = 10 s)` ends the loop and waits for the send in progress. Started rows turned `unknown` log an `alert` with their count.
- A database error before any send (recording `kind = 'template'`) ends the send `failed`, not `unknown`. The no-template case is one place (`NoTemplate`). A `failed` status
  decrements `sent_count`. `what` has runs of whitespace collapsed into one space (`tidyWhat`, applied by `insertReminder`; slice 6.2's tool goes through it). `parseSchedule` is gone
  (`ScheduleSchema.parse`). `REMINDER_TEMPLATE` is read the same way by the server and the scripts (no default in the scripts; `template:status` also takes the name as an argument).
  `recordReminderStatus` logs (`reminder_status_failed`); `recordStatus` returns nothing again.

## As built: slice 2 (2026-11-22)

What shipped (`set_reminder`, `cancel_reminder`, `list_reminders`, BAJA, undo, context, prompt, help, scenarios), and where it differs from Design 3 to 5.

- **Tools** (`src/agent/schema.ts`, `calls.ts`, `apply.ts` `applyReminderCall`, `execute.ts`, `render.ts`, `say.ts`). `set_reminder {what, schedule, text}` takes the
  typed schedule as is (`ScheduleSchema`; a field that does not apply is left out, not null). The guards are `checkReminder` (`src/reminders/guard.ts`) inside `valueGuards`
  (so MCP can reuse them later; `checkInput` takes an optional `now`): the schedule parses; the first occurrence after the message's own time exists and is at most 366 days
  away; `what` goes through `tidyWhat` and holds no secret or contact data (nor does the message: a message with a secret sets no reminder, whatever the model leaves of it
  in `what`), is at most 100 characters, and holds no number the person did not write. "At least one day between sends" needs no check of its own: a schedule holds one time a
  day, and `interval` starts at 1. The cap of 20 live reminders is decided at the commit point under the account's reminders advisory lock (key 7203005).
- **Refusals the person reads, not the model.** A time that has passed, a first date more than a year away, and a secret in the text are code's own `notice` lines
  (`REPLY_REMINDER_PAST`, `REPLY_REMINDER_FAR`, the fact secret/contact lines), with no retry turn: guessing another time would be setting a reminder the person did not ask for.
  A shape error, an empty or long text or an unwritten number is sent back to the model as usual.
- **"Next" dates are code's.** The prompt teaches the model to send "el 10" as `{every: month, month_days: [10], count: 1, start: today}` (and a weekday or "15 de diciembre" the same
  way), so code finds the date; "mañana" uses a "Próximos días" block (7 days ahead) that the per-message context now carries; "en 2 minutos" is the only clock arithmetic the model does,
  and a time that has passed is refused by code.
- **Rendering** (`src/reminders/describe.ts`, pure): from the typed fields, never from the model's words: "⏰ Te aviso hoy a las 18:00: pagar la Visa.", "⏰ Te aviso todos los lunes y
  jueves a las 08:00, desde el lunes 13/10: tomar la pastilla." (`desde` is the first occurrence, not `start`). A schedule that fires once (no `every`, or `count` 1) reads as a one-off.
  The model's own text beside it must pass `checkSay`, which now refuses "te aviso", "programé" unless a reminder was set and "cancelé" unless one was cancelled.
- **BAJA** (`bajaRequest`, `resolve.ts`): typed text only (not by voice), no model call, case-insensitive: "BAJA", "baja", "dame de baja", "quiero la baja", "por favor baja". Unlike "deshacer" and
  "desconectar" it is honoured **whatever question is open**: an opt-out should not depend on conversation state, and it is undoable. It cancels every live reminder in one batch (the action
  `cancel_all_reminders` is code's own, like `forget_all_confirmed`; no model tool). Replies: "⏰ Cancelé tus 2 recordatorios. Si fue sin querer, escribí «deshacer» y vuelven.", or "No tenés recordatorios para cancelar."
- **Undo** (`src/undo-reminders.ts`, in `undoLast`): what the batch set is cancelled (`reminder_removed`); what it cancelled (one, or all with BAJA) comes back as new rows (`restores`, the message of
  the undo as `inbound_message_id`, `next_due_at` worked out from the asking message's own time). `stale`, with nothing changed, when: a one-off the batch set has been sent (`next_due_at` null);
  a reminder it set was cancelled by a later batch that was not undone; a one-off it cancelled has no occurrence left; or bringing back would take the account over 20. The batch rule in `lastBatch` gains
  "set or cancelled a reminder". `warren_undo_last` over MCP reaches these batches too, so its presenter and output schema gained `reminder_removed` / `reminder_restored` items and a `reminder` view (the one
  change outside WhatsApp; no MCP reminder tools).
- **Context.** The live reminders (id, text, schedule in words, next date) are in the per-message context under "Recordatorios", never in the cached prefix; `cancel_reminder` takes only an id listed there. They are
  also a source for the numbers check. The system prompt and the tool list changed, so `pnpm eval` and `pnpm eval:scenarios` were rerun.
- **Help** gains a line for reminders and BAJA. Action label `remind` (set, cancel, BAJA); `list_reminders` is a `reply`.
- **Scenarios** `s183`–`s199` (tag `reminder`; seeds `reminders`, expectation `liveReminders`: the closed list of live reminders after a turn, graded by text, next date and stored fields; a wrong one under a reply that says it worked is a
  silent wrong change, and `⏰` counts as a success mark).
- **Not done:** the MCP tools for reminders; a "snooze"; per-reminder undo of a single cancel by name (the undo is the last batch, like everything else).

### Changes after review (slice 2)

- **`count` is never drained.** `normalizeSchedule(schedule, now)` (`schedule.ts`) makes what defaults to `start` explicit (the weekday, the day of the month, the month), finds the first
  occurrence after now with `count` left out, moves `start` to that day (the same series: intervals still count from the same place) and then applies `count`. `checkReminder` stores that
  schedule and refuses only when nothing is left (the time of a one-off has passed, or `until` is before now). So "3 veces a las 8" asked at 14:00 is three from tomorrow, and "el 10" on the
  10th after 09:00 is next month's. "Now" is the later of the message's own time and the processor's clock (`ProcessorOptions.clock`; tests and the scenario eval pass a fixed past one), so a
  message that waited cannot set a reminder for a moment that went by.
- **`checkSay`**: "¿Cuál querés que cancele?" is a question, not a claim of a cancel (`(?<!\bque )`), and "te recuerdo" / "te lo recuerdo" are no longer claims. When `set_reminder` ran, the model's own
  words are dropped (code's ⏰ line is the truth; they could only contradict it) and not sent back for a repair.
- **Secrets**: `holdsSecretValue` (memory.ts) is what a reminder refuses: a value, not the word. "Cambiar la contraseña del wifi", "renovar el pin de la tarjeta" and "el código postal" are reminders;
  "pagar con la clave 7788" is not. (A message with the word still counts as sensitive for the stored text: `sensitive()` is unchanged.)
- **One unparseable row** no longer breaks anything: `liveReminders` skips it (and logs `reminder_bad_schedule`), BAJA cancels it without parsing, undo skips it. The `start` check of the schedule no longer
  throws on a string that is not a date (a refine that threw was what made `safeParse` throw).
- **MCP**: `warren_undo_last` refuses a batch that set or cancelled reminders (`whatsapp_only`: nothing changed, "deshacer" on WhatsApp takes it back). This replaces the presenter change of the first
  version: `src/mcp` now only gains that refusal.
- **Undo reads its rows `FOR UPDATE`**, under the account's reminders lock taken once by `undoLast` (and once by `applyReminderCall` for a write), so a sweep that is ending a one-off waits and the undo
  sees it ended (stale) instead of failing the commit. `undoLast` takes `now` from its caller (required), as do `ExecuteInput`, `Guard` and the agent loop.
- **BAJA** also reads "quiero darme de baja", "quiero baja"; the full-cap reply no longer promises to set it after a cancel ("Cancelá uno y pedime este de nuevo.").
- **Cleanups**: one `isOnce`; one phrase for a reminder in the list and in the context (`describeReminder`: "• pagar el alquiler — el 5 de cada mes a las 09:00 (próximo: …)"); `reminderReply` (render.ts) maps
  a reminder outcome to its line and step; `batchReminders` and `reminderById` share their columns and mapping; a seeded scenario reminder with no occurrence at the first turn is an error.
- **Test split**: `s187` and `s195` mirrored the prompt's examples and moved to dev; `s200` ("a fin de mes", a one-off on the last day) and `s201` (a payment habit as a statement) are the new test scenarios;
  `s202` (3 times, asked in the afternoon) and `s203` ("el 10" on the 10th) are dev. `s097` is a dev scenario, so its counter-example in the prompt does not touch the held-out split.

## As built: BAJA removed (2026-11-22)

Decided by Ticiano: no BAJA. Stopping reminders is an ordinary request to the model, with the usual guards and undo.

- **Removed:** `bajaRequest` and its wiring in `process.ts`, the code action `cancel_all_reminders` (its outcome, `cancelAllReminders`, renderer, step, label and the claim list entry),
  the BAJA line of the help, its tests and scenarios. The template body is now "Recordatorio que pediste en Warren: {{1}}. Si ya no lo necesitás, decime y lo cancelo." (changed at Meta by the owner).
  The earlier "as built" sections above describe BAJA as it was shipped.
- **"Cancelá todos los recordatorios"** is one `cancel_reminder` per reminder listed under "Recordatorios", all in the same turn. That already worked, with no new tool: every call is checked
  against the ids shown, runs in the one message's batch under the account's reminders lock, and writes its own line ("⏰ Cancelé el recordatorio: …"), so the reply lists exactly what was cancelled;
  one "deshacer" brings them all back (`undo-reminders.ts` already handled several cancelled rows in a batch). The prompt says it, with an example; a bare "baja" and "no quiero más recordatorios"
  mean the same.
- **Not visible to the model:** a reminder that has just been sent is not in the conversation window (the window is made of `inbound_message` rows, and a send is a `reminder_send` row), and a one-off that
  fired is no longer live, so it is not listed under "Recordatorios" either. After "⏰ Recordatorio: pagar la Visa" arrives, "cancelá este" is understood only when the reminder still repeats and is the one
  live (or its words are in the message). For a one-off there is nothing left to cancel. Not built: showing the model what was just sent (a small context line from `reminder_send`) is the follow-up if people
  answer reminders with "cancelá este".
- **MCP's undo refusal** for reminder batches is unchanged.
- **Scenarios:** `s192` is "cancelá todos los recordatorios" then "deshacer" (dev, since its wording is in the prompt); `s204` ("no quiero más recordatorios") and `s205` ("cancelá este" with one live) are dev;
  `s206` ("borrame todos los recordatorios que tengo") and `s207` (cancel one by name, keep the other) are test.

### A time of today that has passed (after the BAJA removal)

A held-out scenario ("recordame hoy a las 10 llamar al banco" at 15:00) failed about 3 runs in 8 with a silent wrong change. Dev scenarios of the same class (`s212`–`s214`) showed why: the prompt said
"never a time that has already passed", so the model dodged the refusal by sending **tomorrow's** date ("Las 8 de hoy ya pasaron, te lo dejo para mañana"), and the reply, rendered from that schedule, said
"mañana": a reminder on a day the person never named. Two fixes, at two layers:

- **Prompt:** send the time they said even if it has passed today (code tells them and asks for another day); never move a reminder to another day, and never turn a time of today into tomorrow.
- **Code** (`checkCall`, the conversation layer): when the message names a time of today ("hoy a las 9", "a las 8 de hoy") and no other day beside it ("mañana", "pasado"), a one-time schedule whose first occurrence is
  not today is refused with `REPLY_REMINDER_PAST`, whoever moved it: the model sending tomorrow, or a one-time monthly or weekly schedule that `normalizeSchedule` would roll forward. A repeating schedule is still rolled
  ("todos los días a las 8, 5 veces" at 14:00 is from tomorrow, and the reply says "desde mañana"), and "hoy gasté 3500, recordame el viernes…" names no time of today, so it is untouched.
