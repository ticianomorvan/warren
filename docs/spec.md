# Spec: fast WhatsApp expense agent (first slice of a new personal-finance product)

Status: read by Ticiano 2026-11-20; decisions folded in. Product is **Warren** on `heywarren.app` (DNS on Vercel); webhook host `wa.heywarren.app` → Railway. Repo: `ticianomorvan/warren`, **fresh start** on `main`; the old mail-ledger code is tagged `v0-mail-ledger`. Local checkout `~/Projects/personal/warren`; credentials in its gitignored `.env` (checked working 2026-11-20).

## Goal

A person in Argentina sends a WhatsApp message such as "café 3500 y súper 12.000 con la visa, ayer 20 lucas de nafta". Within a second they see Warren is on it (blue ticks and "typing…"), and a moment later they get one compact reply listing each movement it understood. Warren is never silent: if the answer is slow or fails, it says so. Each movement is stored with the message it came from. They can correct it in plain words ("no, el café fue 3800", "borrá el último") and ask simple questions ("¿cuánto gasté este mes en super?").

This is the input loop the rest of the product builds on: receipts, statements and the month view all reuse its pipeline, data model and latency budget.

How we know it worked:
- **First signal, the one that matters.** Read receipt plus typing indicator accepted by Meta within 1.0 s of the webhook arriving, at p95, over the last 100 real messages (`pnpm latency`, received → typing sent). Slice 2 measured p50 417 ms and p95 788 ms.
- **Answer.** Webhook received to Meta's send API accepting the reply: p50 ≤ 2.0 s and p95 ≤ 4.0 s on logging messages, same report. Expect about 1.5 s: the model takes about 1 s, and Meta's send call takes 0.5–0.7 s, with no documented way to make it faster.
- **Never silent.** Every message ends in something the user can see: the answer; an interim note when the answer is not out after 10 s; or a failure message when processing fails for good. The one exception is a send whose outcome is `unknown`: it may have arrived, so nothing follows it. An integration test covers the interim and failure paths.
- **Latency, end to end (coarse).** Inbound message `timestamp` to the `delivered` status timestamp. Both are whole seconds, so this is a rough check only; target p50 ≤ 4 s. The slice 2 echo measured 3 s.
- **Accuracy.** On the eval set (≥ 80 Argentine Spanish messages), at least 97% of messages come out fully correct (every amount, currency, date, count of movements and direction), and no amount is ever wrong silently. Run with `pnpm eval`.
- **Reliability.** No message is lost or logged twice when Meta retries or the process restarts. An integration test proves it.

## Not doing (this spec)

- Images, PDFs, voice notes, comprobantes, card statements. Later slices reuse this pipeline for them.
- Month view or any web UI, budgets, reminders and outbound templates (those cost money outside the 24 h window).
- Self-serve sign-up. Users are an allowlist of WhatsApp numbers, and the test number only reaches allowlisted recipients anyway.
- Exchange-rate conversion or inflation views. USD is stored as USD.
- Business verification and the production phone number. Unverified accounts are capped at 250 users a day, which is plenty for now.
- Anything from warren's security model (row-level security, hash chain, per-user sealing). Revisit when real users arrive.

## What exists

- **warren** (`ticianomorvan/warren`; the old code is at the tag `v0-mail-ledger`, and the paths below are from that tag). It is not reused as a codebase, because its setup cost is the thing we are escaping. Three ideas are worth copying:
  - Amounts as decimal strings with a separate direction (`packages/db/src/schema.ts`, `movement`).
  - The Argentine calendar day (`packages/core/src/time/argentina.ts`).
  - Every movement links to its source (`movement_source`).
  - Its former WhatsApp notifier was deleted, and it has no LLM code.
- **Meta Cloud API facts** (researched 2026-11-20, from official pages unless marked otherwise):
  - **Webhooks.** Signed with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret). Any non-200 response is retried for up to 7 days, and duplicates are possible.
  - **Read receipt and typing indicator.** One call to `POST /{phone-number-id}/messages` with `status:"read"` plus `typing_indicator`. The indicator lasts until we reply or 25 s pass.
  - **Rate limits.** 80 messages per second per number, and about 1 message every 6 s per user pair.
  - **Graph version.** v27.0 in the current docs; keep it in config.
  - **Pricing changed on 2026-10-01.** Service replies are free only for the first 1,000 per business number per month. Beyond that they are charged, and without a payment method they are not delivered.
  - **Speed and scale (researched 2026-11-21).** Meta documents no speed lever: no regional API host, no batching for messages, no latency figure or SLA. Data residency ("local storage") changes only where data is kept at rest. The On-Premises API is shut down (last client expired 2025-10-23), and nothing shows a BSP is faster. The free tier counts *delivered* service messages and resets monthly. Meta does not document its webhook timeout; we answer in well under 50 ms. Status webhooks arrive under the same `messages` field as inbound messages and cannot be filtered. Throughput is 80 messages/s per number and only upgrades at 100K+ users a day, far beyond us.
  - **Billing currency.** ARS billing exists. The currency is fixed when the account is created.
  - **Media.** URLs expire after 5 minutes; documents up to 100 MB. Relevant for later slices.
- **AI policy (Meta Terms §4.7, "AI Providers", last modified 2026-09-23).** It bans offering AI as the *primary* functionality. Our reading is that a bot that logs expenses and answers questions about the user's own spending uses AI as a means, so it is allowed. Meta has not confirmed this, and the clause gives Meta "sole discretion". The design keeps the bot narrow on purpose.
- **Model facts (claude-api skill, cached 2026-11-03).**
  - `claude-haiku-5-5` costs $0.10 / $0.50 per million tokens. It can turn thinking off at effort `high` or below.
  - `claude-opus-5-5` offers fast mode (`speed:"fast"`) at $8 / $40.
  - Both support structured outputs (`output_config.format`) and prompt caching.

## Design

**Shape.**
- One TypeScript service on Node 24, long-running (not serverless), with one Postgres. It is a single package, not a monorepo.
- Hosted on Railway in US East, with Postgres on the same private network. Meta's Cloud API and Anthropic's API are both US-hosted, so US East keeps every hop short.
- A long-running process holds keep-alive connections to both APIs and has no cold starts, which matters most at low traffic.

**Request path (one LLM round trip, no agent loop).**
1. `POST /webhook`: check the signature on the raw body. Insert the inbound message with `wamid` as a unique key, status `pending`. Return 200. Total target is under 50 ms. A repeated `wamid` is acknowledged and ignored.
2. Without waiting on each other:
   - (a) send read receipt plus typing indicator;
   - (b) load context, which is the user's last 5 movements and today's Argentine date;
   - (c) call the model.
3. **The model is a parser, not an agent.** It returns one typed command through structured outputs:
   - `log { movements[] }`, where each movement carries direction, amount (a decimal string), currency, date, description, category from a fixed list, payment method and a confidence flag;
   - `correct { target, changes }`;
   - `delete { target }`;
   - `query { period, category?, payment? }`;
   - `help`, or `off_topic`.
4. **Code executes the command** in one transaction:
   - It validates, for example that amounts are positive, the date is not in the future, and anything low-confidence gets marked.
   - It writes movements linked to the inbound message, so a retry cannot duplicate them.
   - It computes any totals itself. The model never does arithmetic.
5. Code renders the reply from a template ("✓ Café $3.500 · Súper $12.000 (Visa)"), sends it, marks the message `done`, and records per-stage timings on the message row.
6. **Recovery.** On startup and every 30 s, a sweep re-runs any message left `pending` or `processing` too long. That covers a crash after the 200 was returned.

**Transparency (decided 2026-11-21).** The time that matters is time to the first signal; the user will wait for the answer if they can see work is happening.
- **Instant signal.** The read receipt plus typing indicator: one call, about 0.4 s, not documented as billed. The indicator lasts until we reply or 25 s pass.
- **Slow.** If the answer is not out 10 s after the webhook, send one interim note ("Sigo con esto, ya te respondo.") and show the typing indicator again. At most once per message.
- **Failed.** When processing fails for good (the model keeps failing after its retries, or there is nothing valid to answer with), send a short failure message saying the message was not processed and to try again. A 30 s deadline per message ends in the same failure message, and work still running after it is dropped, so a late answer can never contradict it.
- **Cost.** Interim and failure messages count toward the 1,000 free delivered service messages a month, like any reply. Both are rare by design. The per-user pair limit (1 message per 6 s, bursts of up to 45) does not bind.
- **No done mark (removed 2026-11-21, Ticiano's call).** A ✅ reaction after the reply was built and then dropped: the reply already confirms the message, and the reaction was an extra Graph call with undocumented billing.
- **Why not a reaction as the first signal.** Measured 2026-11-21 against Graph: a reaction takes 670–763 ms to be accepted, like a text send (510–720 ms), against 320–390 ms for read plus typing. Setting, replacing and removing a reaction (emoji `""`) all succeeded. Meta does not document whether reactions are billed; check Meta's pricing analytics once there is a payment method.

**Prompt.**
- A frozen system prompt sits first, under one cache breakpoint. It holds the Argentine money conventions:
  - "3.500" means 3500, "3,5k" and "20 lucas" are thousands, "u$s" is USD;
  - the "visa" or "mp" style payment names;
  - the categories and the few-shot examples.
- Per-request data (today's date, recent movements, the message) goes after the breakpoint.
- The eval checks `cache_read_input_tokens` to confirm the cache actually hits.

**Data.**
- `user`: WhatsApp id, name, allowlisted.
- `inbound_message`: wamid, user, raw payload, status, timings.
- `movement`: user, direction, amount as numeric, currency, date in the Argentine day, description, category, payment method, source message, and `superseded_by` so corrections keep history.
- `reply`: outbound wamid, delivered timestamp.
- Plain SQL migrations.

**Narrow on purpose.**
- Off-topic messages get one short canned reply.
- "ayuda" returns a human contact, which Meta's messaging policy asks for.
- Platform data is never used for model training.

**Model choice is set by measurement, not taste.** The eval runs both candidates:
- Haiku 5.5 at low effort with thinking off;
- Sonnet 5.5 at low effort with `thinking: between_tools`.

Opus is out (Ticiano's call). Its parsing job has no tools, so it would be overkill, and its token cost would need watching.

The rule is to pick the cheapest one that meets both the accuracy bar and the p95 bar. If neither meets them, we revisit the prompt before reaching for anything else.

**Meta approach (decided).**
- Use the Cloud API directly. No BSP (Twilio, 360dialog and others): it adds a hop and a markup and gives us nothing we need.
- Kapso is rejected too. Its hosted proxy adds a hop to every webhook and send, and adds a platform fee on top of Meta's.
- What Kapso adds (shared inbox, conversation storage, embedded signup for onboarding *other* businesses' numbers) is not what we need with one number.
- The Meta surface we use is small: send, read with typing, media download, and the webhook signature check. A thin typed client of our own (~100 lines) covers it.
- Webhook subscription is done by API (`/{app-id}/subscriptions`, `/{waba-id}/subscribed_apps`), so no dashboard step is needed.
- **Development.** Your Meta developer app, the WhatsApp product, a business portfolio, and Meta's free test number with your number allowlisted. Use a system-user permanent token, not the 24 h token.
- **Production (later).**
  - A dedicated prepaid Argentine mobile line that has never been on WhatsApp.
  - The product name as display name.
  - An ARS payment method before we pass 1,000 service messages a month.
  - Business verification once we near 250 users a day. Whether a monotributista can verify is unconfirmed; check it in Meta Business Settings first.

**Rejected alternatives.**
- **A tool-calling agent loop, or Managed Agents.** At least two model round trips per question, and the model would do arithmetic and write free-form replies. That is slower and less reliable than parse, then execute, then render.
- **Serverless on Vercel.** It works, but cold starts at low traffic eat into the latency budget.
- **A regex fast path ahead of the model.** Two parsers to keep consistent. Add one only if the eval shows the model misses p95.
- **Building on warren.** Its operational weight is the problem being solved.
- **Would we design it this way from scratch today?** Yes. This spec is that from-scratch design.

## Slices

Each slice ships on its own and comes with its proof.

1. **Repo, eval set and model choice. Needs no Meta access, so it can run while you set Meta up.**
   - Repo with lint, typecheck and tests in CI.
   - Eval set of 80+ messages with expected commands:
     - real phrasings, multi-movement messages and tricky numbers ("3.500", "1,5M", "20 lucas");
     - relative dates, USD, income ("cobré el sueldo"), corrections and off-topic messages.
   - The eval runner prints accuracy per field and p50/p95 latency per candidate.
   - Proof: `pnpm eval` output for both candidates; the chosen model is recorded in the README with the numbers.
2. **Webhook and an echo with timing, on Railway.**
   - Signature check, `wamid` dedupe, inbound persisted before the 200, typing indicator, reply "recibido", stage timings.
   - This measures the latency floor of Meta plus hosting with no model in the path.
   - Proof:
     - `npm test` covers bad signature → 401, duplicate `wamid` → one row, and a crash after the 200 → the sweep replies once;
     - a message from your phone, then `pnpm latency` showing the floor.
3. **Logging live.**
   - Parser command `log`, movements stored, reply rendered from the template; multiple movements per message.
   - The transparency rules in Design: typing in parallel with the model, the 10 s interim note, the failure message, and the 30 s deadline.
   - Proof:
     - integration test: a recorded webhook payload against a local server and Postgres produces the expected rows and reply text, and a slow or failing model produces exactly one interim note or one failure message;
     - live, 20 real messages from your phone, then `pnpm latency` meets the latency targets in Goal.
4. **Corrections, delete and queries.**
   - `correct`, `delete` and `query`, with totals computed in SQL.
   - Proof: eval cases for each command pass, and an integration test checks that a correction keeps history through `superseded_by` and that the query total equals the SQL sum.

## Open questions (yours)

1. ~~Repo~~: same repo, fresh start. Decided.
2. ~~Meta account~~: Ticiano creates it following the guide given 2026-11-20. Decided.
3. ~~Model rule~~: Haiku 5.5 vs Sonnet 5.5, cheapest passing wins. Decided.
4. ~~Accounts~~: Ticiano runs `railway login` and provides the Anthropic key. Decided.

## Slice 1 result (2026-11-20)

**Decision: `claude-haiku-5-5`, effort `low`, thinking `disabled`.** It is the cheapest candidate and passes the gate (at least 97% fully correct, no silently wrong amount) on the held-out test split. Sonnet 5.5 (effort `low`, `thinking: between_tools`) also passes but costs about 15 times more per message and is about 2.1 times slower, so it is not needed.

| Model      | Split     | Fully correct | Silent wrong amounts | p50 / p95        | Cache read (mean) | Cost per message |
| ---------- | --------- | ------------- | -------------------- | ---------------- | ----------------- | ---------------- |
| Haiku 5.5  | test (25) | 25/25         | 0                    | 988 / 1,174 ms   | 7,770 tokens      | US$0.00016       |
| Sonnet 5.5 | test (25) | 25/25         | 0                    | 2,125 / 2,506 ms | 7,770 tokens      | US$0.0023        |
| Haiku 5.5  | dev (106) | 106/106       | 0                    | 984 / 1,162 ms   | 7,770 tokens      | US$0.00016       |
| Sonnet 5.5 | dev (106) | 106/106       | 0                    | 2,072 / 2,498 ms | 7,770 tokens      | US$0.0024        |

- Eval set: 131 messages in `evals/cases.jsonl` (106 dev, 25 test), 9 of them ambiguous on purpose. The prompt needed no tuning on the dev split: the first dev run of the final prompt was already 100%.
- After review (few-shot examples no longer equal any eval message, stricter grader): Haiku, all 131 messages, 131/131 fully correct (dev 106/106, test 25/25), 0 silent, p50 / p95 967 / 1,128 ms, US$0.0212. The Sonnet rows above predate these changes and were not rerun.
- Prompt: about 8,170 tokens in total, of which 7,770 are the frozen cached prefix. `cache_read_input_tokens` was 7,770 on every request after the first, on both models. Both models' minimum cacheable prefix is 512 tokens.
- Latency was measured from a Mac in Argentina, so it is indicative only. Real latency is measured on Railway in slice 2. Haiku's p95 of about 1.2 s is inside the 2.0 s budget for the whole request path, with room for the other steps. Sonnet's 2.5 s p95 is not.
- Caveats: the eval messages were written by the same agent that wrote the prompt, so they are likely easier than real traffic, and 25 test messages is a small sample. Slice 3 should add real messages to the set and re-run it.
- Schema notes: `query` also carries `direction` (in, out or null) so "¿cuánto cobré?" can be told from "¿cuánto gasté?", and `correct` and `delete` carry a `confidence`. Query periods are an enum (`this_month`, `last_week`, ...) that code turns into dates, so the model does no date arithmetic there either.
- API spend for the whole slice: about US$0.40, against the US$2 cap.

## Slice 2 result (2026-11-20)

Delivered: webhook with signature check, `wamid` dedupe, inbound row persisted before the 200, read receipt plus typing indicator, reply "recibido", per-stage timings, recovery sweep (startup and every 30 s, attempts cap 5, atomic claim), `pnpm latency`. Tests (PGlite, Graph API injected) cover bad signature, duplicate `wamid`, crash then sweep replies once, status webhooks and GET verification. Deployed on Railway US East at `wa.heywarren.app`, Meta subscribed by API. Merged as PR #33 on 2026-11-21.

Measured with real messages from Ticiano's phone (2026-11-21, 11 messages, two batches): received → typing sent p50 417 ms, p95 788 ms; received → reply sent p50 1,125 ms, p95 1,616 ms; message → delivered about 3 s. Our server's share is about 10 ms. Meta's read-and-typing call takes about 0.4 s and its send call 0.5–0.7 s, even on a warm keep-alive connection. That floor is why the Goal's targets were changed on 2026-11-21 to put the first signal first.

Slice 3 notes (decided in the slice 2 review):
- The user table is `account`, not the reserved word `user`. `movement` and `reply` reference `inbound_message.id`, not the wamid.
- Sends are at most once: a message whose send outcome is unknown ends as `unknown`, never resent.
- The allowlist is explicit: `ALLOWED_WA_IDS=*` answers everyone, empty answers nobody.

## Slice 3 notes

Decisions the slice brief did not specify:
- The commit point is `inbound_message.reply_text IS NOT NULL`. The sweep reads it to send a stored reply without the model.
- Model output with an invalid amount, date or description is "invalid output": it fails the message, since storing a guess would be a silently wrong amount. Only "more than 10 movements" is stored, as low confidence.
- The interim note and the failure notice are not stored as `reply` rows (only the failure notice, so its status is kept); this keeps one `reply` row per answered message for `pnpm latency`.
- A failure notice that dies between its timestamp and its send is lost, not retried: at most once beats a duplicate.
- `ANTHROPIC_API_KEY` is now required config, so a missing key stops the server at startup instead of failing every message.
- `validateCommand` returns `fatal` (a `log` value the table cannot hold) next to `issues`; only `fatal` fails a message. A `delete` or `correct` with an empty target is doubtful, not fatal, and gets the "not yet" reply.
- A movement dated in another year than the message renders `dd/mm/yy`.

## Slice 4 notes

Decisions the slice brief did not specify:
- **Resolving a target (revised 2026-11-21 after live use).** `correct` and `delete` carry a nullable `target_index` (the number in the list shown) next to `target`, but `target` only echoes the row the model chose, so code also reads the person's own message (`resolveTarget`). In order: (1) a position the person wrote wins, even when the model's `target` words name another row or its number differs (live bug: "el 2 fue 4500" came back with number 2, a café, and `target: "súper"`, and asked). A position is a bare "2", or "el|la|lo|del|numero N" (digits or "dos", "tres"…) followed by the end, a punctuation mark or a verb or connector ("fue", "era", "por", "a", "borrá…", "cambiá…"). It is never an article before an amount or a date ("el 2.500", "el 2,5", "el 1 luca", "el 3/11", "el 15 de octubre", "el 3 pesos") and never "no el 1"; a number above the list's length is dropped. `primero` and `anterior` use the model's number. "Último/a" is a position only when the rest of the message names nothing ("el último", "borrá lo último"); with a description ("el último café", "la última nafta") it is the newest row that description names. Two positions in one message ("el dos bórralo, cambiame el primero") are two actions: the reply is "Por ahora hago una cosa por mensaje" and nothing changes. (2) Otherwise the rows whose description shares a 4-letter stem with `target`, or whose category name is the whole target, are the candidates (never a stem of a category or payment: "entrada" must not find Netflix). The message's details (payment, old amount also as "15 mil"/"20k", hoy/ayer, dd/mm) narrow them, except a value the person is setting (`changes`: the new amount, date or payment), which is not about the old row ("el café fue 4000" must not pick the café that already is 4000). **The newest candidate left wins**: a correction almost always means the one just mentioned. This replaced "ask when several match". The reply shows the choice: the old values in "(antes …)" and, when the row is not from today, its date (`· ayer`, `· 18/11`). (3) No candidate asks; "last" is number 1 and a different number with it asks. Low confidence only asks when no words match.
- **Messages of one sender run one at a time.** A message reads its list before the parse, so "nafta 20000" stored, "café 3500" still parsing and "uy, era 3800" would correct the nafta. `run` chains each `wa_id`'s messages in the order they are handed in (kick and sweep), single process, in a promise map. A message waiting in a chain ages toward its deadline as before. A shutdown hands the queued ones back as `pending`. Cost: a burst from one person is answered one reply at a time.
- A sender's next message starts once the previous one has committed, not after its reply is sent (decided in review, 2026-11-21). Ordering only needs the stored change, and waiting for the send would add ~0.6 s per queued message. Replies in a burst can arrive out of order when one send is slow.
- **Answering a `¿Cuál?` question is done in code, not by the model.** The commit stores the list numbers a question showed (`inbound_message.asked_numbers`, migration 006) and the command that was really run. When the sender's previous exchange is within 10 minutes, its reply was a question and its command a `correct` or `delete`, and the new message is only an answer (`answerNumber`: "2", "el 2", "dale el 2", "la tres", "el primero" = the first number shown in that question, "el último" = row 1, "sí"/"dale" after a one-option question), the previous action runs on that row whatever the model returned (`help`, `off_topic`, a correction with no changes). Only a confident `correct` with changes of its own wins over the question. The stored command of such a message is the one that ran. Haiku still sometimes reads "el 2" or "el primero" as `help` (eval cases c145, c146); code now covers them, the eval measures the model alone.
- **Second guard.** Inside the commit transaction the live list is read again; if it differs from the one the model saw (ids and order), the reply is the question over the current list and nothing changes.
- **Short-term memory.** The parser gets the sender's previous exchange (their last message and the reply stored for it) when that message arrived at most 10 minutes before the current one and its reply was committed (`store.previousExchange`). It sits in the per-request part, after the cache breakpoint, as `Intercambio anterior … (persona) … (Warren) …`, one line each, clipped to 400 characters. The prompt says a short answer after a `¿Cuál?` question ('2', 'el 2', 'la primera') repeats the previous request aimed at that number; 'sí'/'dale' is an answer only when exactly one option was listed (with several, the model returns a null number at low confidence and code asks again); a bare number after a reply that was not a question is `help`, never an amount; and that nothing from the previous exchange leaks into a new `log` or query. A bare number is also a position for code, so the answer does not depend on the model alone.
- **Context is 10 movements, not 5.** A `log` can hold 10 movements, so 10 is the least that lets a person fix any movement of the message they just sent. It costs about 150 tokens in the volatile part.
- **A question says how to answer.** When nothing matches (or "last" contradicts its number) the reply is `¿Cuál? 1. … · 2. …` plus `Respondé con el número, por ejemplo "el 1 fue 4100" o "borrá el 1".`, and nothing changes. The numbers are the ones of the list the parser sees. It lists the newest 3; with an empty list it says there is nothing yet. A bare "el 3" with no change gets "Incluí el cambio, por ejemplo: "el 2 fue 3800"".
- **A stale target replies, it does not re-resolve.** Re-resolving a message against a newer list could change a different movement than the person meant. The reply is "ya fue corregido o borrado, mandame de nuevo".
- **A corrected movement is the newest.** The new row has a new id, so "borrá el último" after correcting an older movement means the one just corrected. The reading is natural and keeps the list a plain `ORDER BY id DESC`.
- **An unstorable value in a `correct`** (amount, date, description, payment) is committed as a reply ("No entendí el valor nuevo… por ejemplo…"), not as the generic failure notice, and changes nothing. A `log`'s unstorable value still fails the message. A correction that changes nothing is not an error: "Incluí el cambio…" (nothing set) or "Ya figura así" (values equal to the current ones, no new row). Whether anything changed is computed in `src/movement.ts` (`changedFields`); `render.ts` only formats.
- **A new correction row is `high` confidence;** a low-confidence correction never gets that far, it asks.
- **Soft delete** is `deleted_at` + `deleted_by` (a reference to the deleting inbound message); a row can be superseded or deleted, never both (a CHECK). The partial index on live rows follows.
- **Weeks are Monday to Sunday and whole**, so `this_week` can end after today; movements cannot be dated in the future, so it makes no difference to totals. Months and years are calendar ones. All ranges are Argentine days (`periodRange`, from the message's own time).
- **Query wording.** Totals are grouped by direction and currency. One line per direction, ARS first, then `Y US$ … (n movimientos).` on its own line. With no direction asked and both present there is a block per direction. `supermercado` reads as "Súper" in replies.
- **Payment filter** is `position(needle in lower(translate(payment, accents)))`, with the needle normalized the same way in code; no `unaccent` extension, which Railway's Postgres may not allow.
- **Commit shape.** `store.commit` takes `execute(tx)` and returns the stored reply (null if it did not commit); the movement SQL lives in `src/ledger.ts` and nothing else. `store.recentMovements` stays: it is how the processor, which has no `sql`, reads the list.
- **Tests.** The harness moved to `src/test-harness.ts` and the command fixtures to `src/command-fixtures.ts`. `src/concurrency.test.ts` runs only with `PG_TEST_URL` (a real Postgres, 12 connections): concurrent corrections and deletes of one movement apply once (it fails without `FOR UPDATE` on the lock), and a burst from one sender is processed in order. PGlite has one connection, so it cannot show either.

Eval (2026-11-21, Haiku 5.5, `pnpm eval --model haiku --split all --budget 0.06`, 154 cases: ambiguous ones expect the newest match; 15 cases carry a previous exchange or test the resolver's inputs ("el último café", a date with a slash, "sí" after one and after three options, a bare number after a confirmation, a query after a correction); few-shot lists and messages differ from every case): 151/154 fully correct (98.1%), 0 silently wrong amounts, 0 silently wrong targets, gate PASS; latency p50 1,216 ms, p95 1,807 ms; US$0.0311 for the run. Misses seen: "el 2" / "el primero" after a question read as `help` (the new "bare number means nothing" rule is a little too eager on Haiku), and "la nafta del 3/11 fue 25000" also sets the date to Nov 3 (harmless: same value). The cost of the final run and the three before it brings the slice to US$0.240 of the US$0.28 cap.

## Roadmap (not scheduled)

Decided by Ticiano on 2026-11-21. None of it is a priority.
- **Short-term memory.** The sender's previous exchange in front of the parser. Done in slice 4.
- **Long-term memory as data.** Aliases ("la visa" is this card), card names and category preferences, stored per account and placed in front of the parser. The parser stays a parser; this is more context, not more behaviour.
- **An agent loop with our existing tools, only for complex messages** (several actions in one message, follow-ups). An increment on the parser: the parse still comes first and handles most messages in one call. Until then a message with two actions gets "Por ahora hago una cosa por mensaje".
