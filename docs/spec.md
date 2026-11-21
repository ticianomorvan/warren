# Spec: fast WhatsApp expense agent (first slice of a new personal-finance product)

Status: read by Ticiano 2026-11-20; decisions folded in. Product is **Warren** on `heywarren.app` (DNS on Vercel); webhook host `wa.heywarren.app` → Railway. Repo: `ticianomorvan/warren`, **fresh start** on `main`; the old mail-ledger code is tagged `v0-mail-ledger`. Local checkout `~/Projects/personal/warren`; credentials in its gitignored `.env` (checked working 2026-11-20).

## Goal

A person in Argentina sends a WhatsApp message such as "café 3500 y súper 12.000 con la visa, ayer 20 lucas de nafta". In about a second they get back one compact reply listing each movement it understood. Each movement is stored with the message it came from. They can correct it in plain words ("no, el café fue 3800", "borrá el último") and ask simple questions ("¿cuánto gasté este mes en super?").

This is the input loop the rest of the product builds on: receipts, statements and the month view all reuse its pipeline, data model and latency budget.

How we know it worked:
- **Latency, server side.** Measured from webhook received to Meta's send API accepting the reply. Target p50 ≤ 1.0 s and p95 ≤ 2.0 s on logging messages, over the last 100 real messages, reported by `npm run latency`.
- **Typing indicator.** It goes out within 300 ms of the webhook arriving.
- **Latency, end to end (coarse).** Inbound message `timestamp` to the `delivered` status timestamp. Both are whole seconds, so this is a rough check only; target p50 ≤ 3 s.
- **Accuracy.** On the eval set (≥ 80 Argentine Spanish messages), at least 97% of messages come out fully correct (every amount, currency, date, count of movements and direction), and no amount is ever wrong silently. Run with `npm run eval`.
- **Reliability.** No message is lost or logged twice when Meta retries or the process restarts. An integration test proves it.

## Not doing (this spec)

- Images, PDFs, voice notes, comprobantes, card statements. Later slices reuse this pipeline for them.
- Month view or any web UI, budgets, reminders and outbound templates (those cost money outside the 24 h window).
- Self-serve sign-up. Users are an allowlist of WhatsApp numbers, and the test number only reaches allowlisted recipients anyway.
- Exchange-rate conversion or inflation views. USD is stored as USD.
- Business verification and the production phone number. Unverified accounts are capped at 250 users a day, which is plenty for now.
- Anything from warren's security model (row-level security, hash chain, per-user sealing). Revisit when real users arrive.

## What exists

- **warren** (`ticianomorvan/warren`; a shallow read-only clone is in the session scratchpad). It is not reused as a codebase, because its setup cost is the thing we are escaping. Three ideas are worth copying:
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
   - Proof: `npm run eval` output for both candidates; the chosen model is recorded in the README with the numbers.
2. **Webhook and an echo with timing, on Railway.**
   - Signature check, `wamid` dedupe, inbound persisted before the 200, typing indicator, reply "recibido", stage timings.
   - This measures the latency floor of Meta plus hosting with no model in the path.
   - Proof:
     - `npm test` covers bad signature → 401, duplicate `wamid` → one row, and a crash after the 200 → the sweep replies once;
     - a message from your phone, then `npm run latency` showing the floor.
3. **Logging live.**
   - Parser command `log`, movements stored, reply rendered from the template; multiple movements per message.
   - Proof:
     - integration test: a recorded webhook payload against a local server and Postgres produces the expected rows and reply text;
     - live, 20 real messages from your phone, then `npm run latency` meets the latency targets in Goal.
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

- Eval set: 131 messages in `evals/cases.jsonl` (106 dev, 25 test), 8 of them ambiguous on purpose. The prompt needed no tuning on the dev split: the first dev run of the final prompt was already 100%.
- Prompt: about 8,170 tokens in total, of which 7,770 are the frozen cached prefix. `cache_read_input_tokens` was 7,770 on every request after the first, on both models. Both models' minimum cacheable prefix is 512 tokens.
- Latency was measured from a Mac in Argentina, so it is indicative only. Real latency is measured on Railway in slice 2. Haiku's p95 of about 1.2 s is inside the 2.0 s budget for the whole request path, with room for the other steps. Sonnet's 2.5 s p95 is not.
- Caveats: the eval messages were written by the same agent that wrote the prompt, so they are likely easier than real traffic, and 25 test messages is a small sample. Slice 3 should add real messages to the set and re-run it.
- Schema notes: `query` also carries `direction` (in, out or null) so "¿cuánto cobré?" can be told from "¿cuánto gasté?", and `correct` and `delete` carry a `confidence`. Query periods are an enum (`this_month`, `last_week`, ...) that code turns into dates, so the model does no date arithmetic there either.
- API spend for the whole slice: about US$0.40, against the US$2 cap.
