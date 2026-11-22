# Spec: Warren v2, an agent that understands intent and acts through guarded tools

Status: read and approved by Ticiano, 2026-11-21 (answers below). It builds on slices 1–4 (`docs/spec.md`) and replaces the
parser-plus-rules layer. A fresh session should be able to build from this file plus `AGENTS.md`.

## Goal

People write the way they write: typos, two actions in one message, "el café de las 10", "el otro",
"uno de los cafés", an answer of "2" after a question, "¿cuánto gasté en noviembre en súper vs octubre?".
Warren works out what they mean, does it, says exactly what it did, and can undo it. The code guards
every write; a fixed set of text rules no longer decides what the person meant.

The four slice 4 review rounds showed the cost of the old split. The model already picks correctly
("el 2 fue 4500" came back with index 2, and "el de las 12 menos 5" pointed at the right café), but
regex rules in `src/resolve.ts` overrode it, and each new rule broke another phrasing.

How we know it worked:

- **Scenario eval** (new, multi-turn). At least 60 conversations. The source is today's real
  transcripts (`inbound_message` rows 24–42), each failure among them, and the sequences in this spec.
  Gate: ≥95% of scenarios fully right, **0 silent wrong changes** (the wrong movement changed or
  deleted, or a wrong amount or date written, under a reply that looks fine), and 0 numbers the model
  invented. Command: `pnpm eval:scenarios`.
- **The single-message eval** (`pnpm eval`) still passes its gate on the `log` and `query` cases.
- **Latency.**
  - The first signal is unchanged: p95 ≤ 1.0 s.
  - Logging: p50 ≤ 2.0 s, p95 ≤ 4.0 s, as today.
  - Corrections, deletes and summaries: p50 ≤ 4 s, p95 ≤ 8 s. The 10 s interim note and the 30 s
    deadline stay.
  - `pnpm latency` reports these by action.
- **Cost:** ≤ US$0.001 per message on average (Haiku 5.5 is ~US$0.00016 per call today).

## Not doing (this spec)

- PDFs. (Photos arrived in slice B2 and voice notes in the voice slice.)
- Reminders and payment due dates: designed in slice G only. Outside the 24 h window they need
  approved WhatsApp utility templates, which are billed per message.
- A web UI, budgets, multi-currency conversion.
- Managed Agents (see Design, Rejected).

## What exists (keep unless stated)

- `src/process.ts`:
  - claims, plus a per-sender lane whose turn passes at the commit;
  - at-most-once send (`send_started_at`), typing in parallel, the 10 s interim note, the 30 s
    deadline, the failure notice, the SIGTERM hand-back.
- `src/store.ts`: the commit point (one transaction), `previousExchange`, `asked_ids`/`asked_numbers`
  (migrations 006–007), and `parsed` (the model output) beside `command` (what ran).
- `src/ledger.ts`:
  - all movement SQL: the live list, insert, `lockLive` (`FOR UPDATE`), supersede, soft delete;
  - query totals as SQL `sum()` grouped by direction and currency. ARS and USD are never converted.
- `src/movement.ts` (`applyChanges`, `changedFields`), `src/parse/validate.ts` (the value rules),
  `src/render.ts` (Argentine formatting and the reply templates), `src/time.ts` (`periodRange`).
- **Replaced:**
  - `src/resolve.ts`, the target heuristics: deleted apart from `answerNumber`;
  - `src/execute.ts`'s command switch;
  - the one-command schema in `src/parse/schema.ts`. Its prompt conventions (Argentine amounts,
    categories) move into the agent's system prompt.
- `evals/` (single-message, 157 cases) and `evals/bench/` (the OpenRouter adapter, branch
  `bench-models`).

## Design

**Shape.**

- A self-hosted agent loop on the Messages API.
- Model: `claude-haiku-5-5`, effort `low`, thinking off. The benchmark (2026-11-21) found nothing
  better at its price.
- Manual loop, about 60 lines, because the code must own four things per message: the deadline
  signal, a step cap (at most 3 model turns), an audit row per tool call, and the commit point.

**Tools.**

- **Read tools** return data to the model:
  - `find_movements({text?, from?, to?, category?, payment?, amount?, limit≤20})` searches the
    sender's full history, beyond the 10 newest. Each row returns its id, date, time, description,
    amount, currency, payment and category.
- **Write tools are terminal.** Code executes them inside the commit point, renders the reply from
  templates, and ends the loop with no further model turn:
  - `log_movements({movements[]})`;
  - `correct_movement({id, changes})`;
  - `delete_movement({id})`;
  - `undo_last()` (slice C);
  - `summarize({from, to | period, group_by: none|category|payment|day|week|month, direction?,
    category?, payment?})`;
  - `ask_user({question, movement_ids[]})`, which stores `asked_ids` for the answer path;
  - `reply({kind: help|off_topic|smalltalk})`, which uses canned texts.
- Several terminal calls in one turn ("borrá el 2 y cambiá el 1") run together in one transaction and
  get one combined reply.
- So a plain log or a summary costs **one** model call, as today. A correction to an older item
  costs two: `find_movements`, then the write.

**Context per call.**

- A frozen system prompt and a fixed tool list under one cache breakpoint.
- Then, volatile: today's Argentine date and time, the 10 newest live movements (with ids and
  times), and the conversation window: the sender's turns from the last 30 min, at most 6, taken from
  `inbound_message.body` and `reply_text`.
- Message threads (beta) are not used. The window is rebuilt from our database, which stays the
  source of truth.

**Guards (code, never the model).**

- Every id must belong to the sender and be live (`lockLive`).
- Changes pass the `log` value rules. Amounts are decimal strings.
- The model never computes totals: `summarize` and the reply templates do.
- Every write reply shows what changed: `✓ Corregido: Café $2.000 (antes $2.900) · 10:10`.
- `undo_last` reverts the sender's last write batch (slice C). No new table: the batch is the inbound message, and what it did
  is in the movement rows (see Agent slice C notes).
- An answer to an `ask_user` question still goes by `asked_ids` in code (`answerNumber`). The
  model never re-guesses it.
- The step cap and deadline end in the failure notice, and nothing is written.

**Decision model (Jev, TypeSafe AI).** It scores a fixed set of options in 70–500 ms. In one
analysis it was ~12 points overconfident, and it agreed with frontier models more than with ground
truth.

- It is not in the request path at first.
- Slice E measures it as a second opinion at the riskiest decision: the agent's chosen movement among
  the candidates. Where it disagrees, or its confidence is low, ask instead of writing.
- It ships only if the scenario eval shows fewer silent wrong changes without many extra questions.
- Access: option scoring is only on TypeSafe's own API or on Vercel AI Gateway (`typesafe-ai/jev`, with `experimental_evaluate`). OpenRouter only lists `typesafe/jev-router`, a model router that uses Jev internally. It can't score our own options, so it doesn't fit (checked 2026-11-21). Spanish support is not documented.

**Rejected.**

- **More text rules:** the failure mode this spec ends.
- **Managed Agents:** a per-session container, session billing, beta status, and an extra hop. Our
  tools hit our own Postgres anyway, so it adds latency for nothing, against a 2–4 s budget.
- **A full agent with model-written final answers:** a second model call on every message, and
  numbers the model might invent.
- **A router plus a specialist parser chain:** two calls on every message.

Would we design it this way from scratch today? Yes: one loop, typed write tools rendered by code,
and history in our database.

## Slices (each ships on its own, with its proof)

- **A. Scenario eval and baseline.**
  - A multi-turn eval runner with grading on the database state after each scenario: which rows,
    which values, which reply.
  - Seeded from today's transcripts.
  - Run it against the current slice 4 pipeline as the baseline.
  - Proof: `pnpm eval:scenarios` prints the pass rate, the silent wrong changes and the latency.
- **B. Agent core.**
  - The tools above, except undo and summaries beyond today's `query` periods.
  - The conversation window and terminal-tool rendering.
  - Delete the `resolve.ts` heuristics.
  - Proof:
    - the scenario gate passes;
    - `pnpm eval` passes on `log`/`query`;
    - 20 live messages that replay today's failing sequences;
    - `pnpm latency` by action.
- **C. Undo and the action log.**
  - Proof: integration tests (undo of a log, of a correction, of a delete, and of a batch), plus a
    live "deshacer".
- **D. Summaries.**
  - Any period or date range, grouped by category, payment, day, week or month. Comparisons ("vs
    octubre") come from two SQL results, rendered by code.
  - Proof: integration tests checking the totals against independent SQL; scenario cases.
- **E. Jev benchmark (separate branch, no product change).**
  - Run as a gate over the slice B scenarios: silent wrong changes, extra questions, latency, cost.
  - Proof: a results file and a ship or no-ship recommendation.
- **F. Long-term memory.**
  - `remember_fact` and `forget_fact` (aliases such as "la visa es la del Galicia", category
    preferences), with the facts shown in context.
  - "¿qué sabés de mí?" lists them.
  - Proof: scenario cases where a remembered alias resolves.
- **G. Reminders (design only first).** Templates, cost per message in ARS, the scheduler, opt-out.
  A separate read before building.

## Decisions (Ticiano, 2026-11-21)

1. Slice 4 (#37) is merged as the base (`8058763`).
2. Trust posture: the agent acts when confident. A wrong pick is visible ("antes …") and is fixed with "deshacer".
3. Jev: Ticiano asked to use OpenRouter, but OpenRouter only has the router variant. Slice E needs a TypeSafe or Vercel AI Gateway key; ask again when slice E starts.
4. Budget: US$1–2 of model spend for scenario-eval runs across slices A–D.

## Agent slice B notes (2026-11-21)

Decisions the spec did not fix. Built on branch `agent-b-core`; `AGENTS.md` describes the result.

- **Tool shapes.** Strict tools allow 24 optional parameters and 16 with a union type, in total. So `changes` and
  the `find_movements` filters are optional (left out when unused) and only a movement's `payment` and
  `summarize`'s three filters are nullable. `ask_user` is `{question, movement_ids, after_answer, changes?}`:
  `after_answer` (none, correct or delete) is what a bare answer will do, stored as `pending`, so code can run it
  without the model. Corrections carry no confidence: the model acts or asks. A logged movement keeps `confidence`
  (the `(?)` mark). `reply.kind` is help, off_topic, smalltalk or nothing_logged (the canned texts).
- **Refusals are answered, not repaired.** The guards that need no database (shape, decimal amounts, real dates not
  in the future, at most 10 movements, an empty correction, an id never shown) run in the loop. A refused call gets an
  error result with the reason and the model another turn, inside the cap of 3. The valid calls of a turn with a
  refused one are not run ("skipped"). A text-only answer costs one turn, once (tool use cannot be forced on every
  model, so the prompt steers and code retries). Without a valid action at the cap the message fails: failure
  notice, nothing written.
- **An id must have been shown** to the model in this message (the list, a `find_movements` result or the pending
  question), on top of "the sender's and live" at the commit. A guessed id that happens to be the sender's is
  refused. One action that finds its movement gone says so on its own line; the others of the message still run.
- **Questions are rendered by code.** `question` is a phrase of at most 6 words with no digit, `$` or sentence
  punctuation, else replaced by "Cuál" / "Qué querés cambiar". Several options are sorted newest first and numbered
  1..k by code (not list positions); only the sender's live ones are offered. Answering ("2", "la segunda", "sí"
  after one option) works for 10 minutes, as before; the model sees the same options with their ids.
- **Conversation window.** 30 minutes, 6 turns, committed messages only (a failed one has no reply), each with
  "hace N min". Replaces `previousExchange`.
- **Reply format.** Corrections keep "(antes …)" and add ` · HH:MM` (logged time) after it when the movement is
  not the newest live one; deletes add it after the movement. The day was already shown when not today. A corrected
  row is a new row, so it counts as the newest afterwards.
- **Stored.** Migration 008: `action`, `tool_calls` (audit with each action's outcome), `model_turns`, `pending`.
  `parsed` is what the model asked for (null when no model ran), `command` what ran, both lists of `{tool, input}`.
- **Prompt.** Old conventions moved over unchanged (amounts, dates, categories, payment, confidence). New rules:
  "el X fue N" is a correction (search first, log only if nothing matches), a number followed by a unit is an old
  amount, not a position. About 11,600 tokens of cached prefix (tools plus system), against 7,770 before.
- **Warm-up.** The first request after a change to the tool schema compiles the strict grammar: about 10 s measured.
  The server sends one tiny request at startup, which also writes the cache. A cache write itself costs no latency.
- **Single-message eval.** It runs the agent and maps the result to the old command shape (`evals/agent.ts`; an
  `ask_user` is a low-confidence command; a target is the list number of the chosen id). 5 cases that are only the
  pick of a question's option are code's job and are not run (`answeredByCode`; unit tests cover `answerAction`).

### Results

- Scenario eval, `--split all`, Haiku 5.5 (the final prompt was tuned on dev only): 98/98 fully right (dev 77/77,
  test 21/21), 0 silent wrong changes, 0 unnecessary questions, 0 invented numbers. Baseline: 82/98, 6 silent.
  Latency per turn (post to stored reply, from a Mac in Argentina): p50 1,842 ms, p95 3,327 ms; by action p50 / p95:
  log 1,878 / 2,288 ms, correct 1,806 / 3,188, delete 1,312 / 3,054, summary 1,696 / 2,070, question 3,100 / 4,523,
  multi-action 2,121 / 2,669. US$0.00026 per turn. Earlier dev runs of the same code: 72/77, 75/77, 76/77 (one
  silent: "el alquiler fue 250000" logged as new), then 77/77 after the prompt rule above; the model is not
  perfectly stable, so read these to about ±2 scenarios.
- Single-message eval, `--split all` (152 cases): 152/152, 0 silent amounts, 0 silent targets, p50 1,634 ms,
  p95 2,773 ms, US$0.0349.
- Open: the 20 live messages and `pnpm latency` on Railway are not done (nothing was deployed).

## Agent slice B2 notes (2026-11-21)

Built on branch `agent-b2`, after live messages #48 and #49 and the eve spike (`docs/eve-spike.md`, branch
`eve-spike`). Ticiano kept our own loop rather than eve. B2 lets the loop answer more freely and read photos,
and keeps every guard. `AGENTS.md` (rule 2, layout, message flow) describes the result.

- **The model's words, and what stays code's.** Every write tool, `summarize` and `ask_user` carry a `text`; `reply`
  is now `reply({text})`; `help` is a separate tool with no input, so the one canned text (it carries the help contact)
  stays code's. Code renders the record of every change first (`✓ Corregido: … (antes …)`), the totals from
  `summarize` and the question with its options, then sends the texts after it, in call order and without repeats.
  The model's text is an addition, never a replacement.
- **`text` is a required nullable field, not an optional one.** Strict tools allow 24 optional parameters in
  total and the tools already used 22; five optional `text` fields would make 27. A nullable is a union, and
  unions went from 4 to 9 of 16.
- **The numbers check (`src/agent/say.ts`, pure).** A text goes out only if it is at most 280 characters, has no `✓`
  (it cannot pass for the record) and every number in it is a number code gave. Numbers are compared by value, not
  by spelling: `12.000`, `12000` and `$12.000,00` are one number; `9:12` and `09:12` are one time; `3/11`,
  `03/11` and `2026-11-03` are one day. A `.` followed by exactly three digits is a thousands mark and a `,` is
  the decimal mark (the Argentine reading), so `12,000` is 12, not 12 thousand. Number words (`dos`, `mil`,
  `veinte`, `lucas`…) count too and pass only when the person wrote the same word.
  - **Sources.** The person's message, the movement list (without ids), the conversation window, the option
    numbers of the pending question, this message's `find_movements` results, and the lines code rendered for
    this message. Not the calendar, the clock or an id: a bare day number inside `2026-11-21` does not let "el 21"
    through, so the model says "hoy", "ayer" or `dd/mm`.
  - **Where it runs.** At the commit point, in `execute`, because the code-rendered lines (which hold
    `$25.000` for "25 lucas") are a source and exist only there. A failing text is dropped, the audit entry says
    `text: dropped` and the reason (`textReason`), and the record is sent alone. A `reply` whose text is dropped, or
    empty, sends `REPLY_SAY_FALLBACK`; the person is never left without an answer. A text beside an action that
    did not apply (`gone`, `unchanged`) is dropped too: it was written for a change that did not happen.
  - **What it does not do.** It checks where a number comes from, not what it means: the model may quote a true
    amount of the wrong movement, and `$3000` passes where code writes `$3.000`. The grader (`invented`) still
    compares amounts with the ledger, now also counting a figure the person wrote in that turn.
- **Digits in descriptions and payments (slice B follow-up #3).** A description or payment with four or more digits in
  a row (`café 12000`, `visa 4509`, `12.000`) is refused like any bad value: the model is told and sends it again.
  It is not dropped, because code copies those fields into the record as written.
- **A turn that searches and writes does not end the loop.** Code runs the reads, holds the writes (audit status `held`)
  and answers each with "your changes were not run; send every change again". The model then sends every
  change with the results in view, inside the same 3-turn cap. A log or a summary alone is still one model call.
  The prompt asks for an action for every part of the request and a `text` for each part not done ("No encontré
  el súper."). This is the fix for #48.
- **Questions about Warren's own actions (#49).** `reply({text})` answers from the conversation window, whose
  (Warren) lines are exactly what was sent. The prompt says that the time at the end of a line is when the movement
  was logged, not when Warren acted.
- **An expired question is marked (slice B follow-up #2).** A question in the window that is not the live pending one
  is followed by "(pregunta vencida: …un número ahora es una posición de “Últimos movimientos”)". Scenario s112
  reproduces the bug: without the mark "el 2 fue 4500" corrected option 2 of the old question (a silent wrong
  change, 4 of 4 runs); with it, 4 of 4 right.
- **Photos.** `payload.ts` reads an `image` message (media id, type, caption). `graph.fetchImage` looks the id up
  (id, then URL), refuses by the declared size and type before downloading, downloads from a Meta https host only
  (`facebook.com`, `fbsbx.com`, `fbcdn.net`, `whatsapp.net`, `whatsapp.com`; the token goes nowhere else), reads at
  most 5 MB (stopping a stream, not trusting `content-length`), and takes the type from the bytes: JPEG, PNG or
  WebP. All through the keep-alive client; no new dependency. The image reaches the model as an image block before
  the context, with the caption in `<mensaje>`. It is never stored: `inbound_message` keeps the media id and
  caption (they are in `payload` and `body`). The read receipt and typing go out at once; the download runs beside
  them. A photo that cannot be read is answered with its own text (too big, wrong type, download failed) through
  the commit point as a code `notice`, with no model call. The conversation window shows `[foto] caption`. A photo is
  never the bare answer to a question.
- **Voice notes were out of scope in B2** (an `audio` message got "Todavía no entiendo audios…"); the voice slice below
  adds them. That reply remains for a server with no `OPENROUTER_API_KEY`. Other kinds keep the short reply.
- **Not verified against real Meta.** The download is tested with a fake `fetch` and the fake Graph. The host allowlist
  is a guess from Meta's media URLs (`lookaside.fbsbx.com`, `mmg.whatsapp.net`); if the live test shows a photo
  answered with "No pude descargar la foto", the `photo_unreadable` log line and the audit's `detail` name the host (never the URL). Add it to `metaHost` in `graph.ts`.
- **Eval changes.**
  - Scenarios s099–s111 come from the spike (the original 98 are unchanged except s017: it expected the canned text
    "Solo puedo ayudarte…", and now accepts any answer that mentions gastos or ingresos).
  - A turn may carry an `image` (a file in `evals/scenarios/fixtures`, sent as a photo with the turn's text as its
    caption; the driver serves the bytes from the fake Graph). The fixture is a synthetic receipt.
  - s112 is new (above).
  - The report prints latency per tag.
- **Prompt.** The conventions are unchanged. New: "Your words" (accounting for every part, no number the model
  was not given, questions start with ¿), "Photos", the tool descriptions, `"text":null` in every example, and a
  first-check rule for "el 1 luca". Two prompt regressions found on dev and fixed:
  - an example that repeated #48 word for word made the model delete the wrong id (it was replaced by one with
    other words);
  - the new sections before "Which movement" made "el 1 luca fue 1500" pick list position 1 in 8 of 24 runs
    (baseline: 0 of 24); moved after the field rules, with the unit rule first, 0 of 40.

### Results (B2)

- Review fixes (a fresh Opus 5.5 review of the diff): the numbers check now also refuses a number plus a multiplier
  that was not given as a phrase ("2 lucas" from "2" and "lucas"), the open families of number words (veinti-,
  dieci-, -cientos, doble, mitad), non-ASCII digits (after NFKC), and a first-person claim of a change ("borré",
  "corregí", "anoté", "listo", "ya está") that this message did not make (a wording check, a denial such as "no
  borré" is fine). `ask_user`'s question refuses number words too. Number words are checked against the
  person's side only, never against lines the model's own descriptions appear in. A search turn tells the model
  before its last turn that it is the last. The media download follows no redirect and has one 8 s budget.
  Known and left: a text cannot quote a figure printed in a photo (it is dropped, so the model is told to log the
  receipt or ask without numbers); a log beside a search is held too, as the brief says, at the cost of one more call.
- Scenario eval, `--split all` (112 scenarios: the 98 of slice B, s099–s111 from the spike, and s112), Haiku 5.5:
  **111/112 fully right (99.1%)**, dev 88/88, test 23/24 (held out), **0 silent wrong changes, 0 invented numbers**,
  0 unnecessary questions. s099–s111: the 10 dev ones all pass; the 3 test ones are inside the test count.
  Slice B on the same scenarios (dev split, without the photo scenario), three runs: 84/87 in the first two; the
  misses are what it cannot do ("borraste el super?", "el taxi lo borraste, no?") and s112.
- Stability. The model is not perfectly stable: dev runs of the final prompt family scored 88/88 in most runs and
  86 or 87 of 88 in some. The misses were an `ask_user` replaced by a "No encontré" reply (the "answer" tag), "el dos
  bórralo, cambiame el primero" without the question, and, before the unit rule moved and gained its "FIRST check",
  "el 1 luca fue 1500" picking list position 1 (a silent wrong change, 8 of 24 probe runs; 0 of 24 on slice B; 0 of
  40 after). Read the counts to about ±2 scenarios. A last prompt edit ("always ask_user") raised `pnpm eval`
  dev misses (c079) and was reverted; the numbers below are for the committed prompt.
- Latency per turn (post to stored reply, Mac in Argentina), by tag, p50 ms, slice B against B2 on the dev split
  (three paired runs; the table is the last paired run, and the all-split run's per-tag p50 is within the same band):

  | Tag            | slice B | B2    |
  | -------------- | ------- | ----- |
  | logging        | 1,554   | 1,518 |
  | correction     | 1,555   | 1,497 |
  | deletion       | 1,468   | 1,546 |
  | answer         | 1,663   | 1,677 |
  | query          | 1,513   | 1,422 |
  | multi-action   | 1,663   | 1,603 |
  | older-item     | 2,916   | 2,718 |
  | typo           | 1,543   | 1,699 |
  | time-reference | 1,608   | 1,590 |
  | other          | 1,681   | 1,369 |

  The worst p50 change over the three pairs and the all-split run is +156 ms (typo) in the table, and +230 ms
  (logging) and +540 ms (older-item) in the first pair, which ran with an earlier prompt and a cold cache
  (its second pair: +203 and +165). p95 by tag is in the run files; the all-split p95 is 3.0 s overall.
- Single-message eval, `--split all` (152 cases): **152/152**, 0 silent amounts, 0 silent targets, p50 1,440 ms,
  p95 1,981 ms (slice B: 1,634 / 2,773 ms), US$0.040.
- Tests: 349 passed (slice B: 242), including the numbers check (unit, 48 cases), the held turn, the photo download
  and its limits, the dropped-text fallback and the expired question. 50 mutations of the guards, each broken one
  at a time: all killed. The real-Postgres suite (`PG_TEST_URL`, `src/concurrency.test.ts`) passes.
- Model spend for the whole slice: about US$0.90 of US$1.00 (tracked runs US$0.83: scenario runs US$0.66 including
  the slice B baseline runs, `pnpm eval` runs US$0.17; plus about US$0.07 of probes, estimated from token use).
- Open: the live test (photo download against real Meta, the 20 live messages) is not done; nothing was deployed.

### Review round 2 (Opus 5.5), fixed on the same PR

- **Claims are judged by this message's outcomes, not by text.** The first version looked for proof in every source,
  including the person's own "borre el super" and old `✓` lines in the window, so "Borré la nafta y corregí el café"
  passed beside a lone correction (#48 again). Now `execute` gives `composeReply` its steps (tool and outcome);
  a deletion, correction or new movement counts only when one of that kind was `applied` in this message (a `gone`
  or `unchanged` one proves nothing). **Only `reply` may also lean on the replies earlier in the conversation**
  (`windowReplies`: "¿borraste el super?" → "Sí, lo borré"), by the wording of those replies (`✓ Borré`, `✓ Corregido`,
  `✓`). Written risk: an old line about another movement can prove a claim about a different one; a reply is
  still checked for numbers, and the record of this message is never replaced by it.
- `canonical("1,000,000")` was read as 1000. A number with more than one comma, or dots that are neither thousands
  nor a single decimal point, now stays distinct and exact (it matches only itself).
- The check refuses figures made of given pieces: "2 lucas" when only "12 lucas" is given (the match is now on a
  number boundary), a minus or range that no source has, a percent, and digits split by a space ("12 500") unless a
  source has them that way.
- `checkSay` takes one `Evidence` object (numbers, words, applied, window), so the word sources are no longer an
  optional argument. The photo download's budget is a graph option (`mediaBudgetMs`) so a hanging fetch is tested.
  The turn-start copy of `seen` in the loop was removed: a turn that searched runs no write, and ids found in a turn
  join `seen` only after every call is checked. `facts` and `window` are required inputs of `execute`; a message
  answered without the model (unreadable photo, bare answer) is built in one place; the photo flag of the context
  comes from the image being there; a `reply` with empty text is one rule, not a special case.

### Live test round (inbound_message #55–#65) and its fixes

What worked: #57 (held, then the delete and the correction on turn 2), #59, #62 (a transfer screenshot logged right:
the photo path works against real Meta), #65. What did not, and what changed:

- **A refused text was replaced by the fallback (#60, #61).** The model's answers listed four cafés, and "cuatro" is a
  number code did not give. Now the loop runs the numbers check on the texts of the turn it is about to accept
  (against what the model was shown, plus the amounts and dates the actions carry; the lines code renders do not
  exist yet) and, if one fails, answers every call with the reason and lets the model send them again inside the
  3-turn cap. The final check at the commit point stays (it knows the lines); on the last turn a bad text goes
  through and is dropped there. `REPLY_SAY_FALLBACK` now reads "Eso no te lo sé decir bien…", not like an error. The
  numbers rule is unchanged: counting is code's.
- **Counts through tools.** `summarize` has a `description` filter (the words of the description, accents and case
  ignored, every word must be in it; one more nullable, 10 of 16 unions), so "cuántos cafés anoté" is code's line:
  `Hoy gastaste $6.400 en café (2 movimientos).` The prompt says counts and totals are code's and that a list of
  movements ("me cobraste dos veces el café?") is a `find_movements` answered without counting. Like a payment,
  the description is copied into the line, so a figure of 4 or more digits there is refused.
- **Echo (#58).** The model had put "cuanto voy este mes" in `summarize.text`. `text` is null unless it adds
  something (prompt), and `checkSay` now drops a text that is, in effect, the person's own message (the same words,
  or the message with at most 16 characters around it; a message of two words or fewer never counts). It is recorded
  as `echoes the person's message`, and it is not sent back for repair: there is nothing to fix.
- **Ask once (#63, #64).** Simplest: `ask_user` has no `text`. Code writes the question and lists the options, once. The
  model's text beside a question only repeated it; a "No encontré el almuerzo" for a part the question does not
  cover goes in the `text` of another action of the same turn. After the person picks an option of a question
  with no action behind it, code (not the model) asks "¿Qué querés cambiar? Café $2.500 · 15:22" about that movement
  alone and keeps it as the pending option; a one-option question shows the time logged, and the pick of a
  one-option question is not narrowed again (it would loop).
- **Scenarios** s113 (no echo), s114 (#60), s115 (#61, test split), s116 (#63 then #64 then the answer) and s117
  (#57: the súper older than the 10 newest, so search, hold, then delete and correct).

Results of this round (Haiku 5.5, final code): scenario eval `--split all`, 117 scenarios: **116/117 fully right (99.1%)**,
dev 92/92, test 24/25 (held out), 0 silent wrong changes, 0 invented numbers, 0 unnecessary questions; per turn p50
1,589 ms, p95 3,289 ms. `pnpm eval --split all`: **149/152** (slice B: 152/152), 0 silent amounts, 0 silent targets,
p50 1,475 ms, p95 2,632 ms. The two dev misses (c085, c101) were not reproduced: eight probe runs of each gave the
right action every time, so they are model variance, not a change in behaviour; the third miss is in the held-out
split. 389 tests (round 2: 362). The new guards were broken one at a time (no repair turn, a repair on the last turn,
an echo repaired or sent, the actions' own amounts not given, only some actions sent back, the reason not told, a
two-word echo, no narrowing, narrowing a one-option question, the summarize description ignored or matched by
any word, a figure in the description): all killed. Spend of this round about US$0.13 (tracked US$0.12 plus probes);
the whole slice is about US$1.05 over its US$1.00, by the extra US$0.30 granted for this round.

## Voice notes notes (2026-11-21)

The photo path is the model: the download shares the photo's Graph code, the answer to a note that cannot be used is a
code `notice` through the commit point, and the transcript is the one new thing a person sends in. A voice note is
turned into text before everything else, so the model, the numbers check, the guards and the commit point are the
ones a typed message gets.

### Decisions (Ticiano and the orchestrator, tested on real notes)

- **Service.** `openai/whisper-large-v3` through OpenRouter's `POST /api/v1/audio/transcriptions` (multipart,
  OpenAI-compatible), the existing `OPENROUTER_API_KEY`, the existing keep-alive `fetch`, `FormData` from `undici`
  (Node's global `FormData` is not accepted by undici's `fetch`: OpenRouter answered 400 "expected object"). No new
  dependency.
- **Pinned to Groq**, `provider={"order":["groq"],"allow_fallbacks":false}`. Unpinned, OpenRouter routes to DeepInfra,
  which heard "YPF" as "IPEF" and "¿Cuánto va este mes?" as "en cuanto a este mes". Pinned, the transcripts matched Groq
  direct, at 0.7 to 1.2 s a note (1.6 s for the first call of a process). A provider that is down is a failure notice,
  not a worse transcript.
- **Request:** `language=es`, `temperature=0`, `response_format=verbose_json` (the gate reads `segments`), and a
  vocabulary prompt (`VOCABULARY_PROMPT`; Groq reads at most 224 tokens). Extending the prompt with six more words
  (farmacia, alquiler, expensas, Netflix, sueldo, transferencia) made the beatbox note come out as "¡Hola!" at
  avg_logprob -0.53, a hair from refusal, so the first version kept the brief's prompt unchanged; "ponele, cambiale" were added in the live test round 2.
- **Formats.** Checked against the service on a clip of Ticiano's note: Ogg/Opus (what WhatsApp sends for a voice
  note), MP3 and MP4/M4A are read. Raw AAC (ADTS) and AMR are refused by Groq ("file must be one of: flac mp3 mp4 mpeg
  mpga m4a ogg opus wav webm", checked 2026-11-21), so they are answered as unsupported. The type is read from the
  bytes (`sniffAudio`), like a photo's, not from what the sender claims. The cap is 3 MB (about 25 minutes of Opus), and
  the lookup's `file_size` and `content-length` are checked before reading, as for photos.
- **Latency.** The read receipt and typing go out first, as for any message; the download starts beside them. The
  transcription has its own 10 s budget inside the message's 30 s deadline, so a hung service becomes a notice while
  there is time left; the 10 s interim note applies unchanged. Both calls get the deadline's `AbortSignal`, so a message
  that passes it does not leave a download or an upload running.
- **Storage.** No audio bytes anywhere. The media id stays in the webhook `payload`; what was heard goes into the
  existing `body` at the commit point (no migration). A refused note keeps no transcript in `body` (it is noise): the
  cause and the transcript's numbers go in the audit `detail` and the `voice_unusable` log line.

### How a voice note flows

1. `hear` (in `process.ts`) runs beside the typing call and the database reads: `fetchAudio`, `transcribe`, `judgeTranscript`.
2. Not usable, each with its own code notice and no model call: too big or too long (`REPLY_VOICE.too_large`),
   another type (`unsupported`), a failed download, a service error, a bad answer or the 10 s budget (`failed`: "No pude
   procesar el audio, ¿me lo escribís?"), the gate (`unclear`: "No te entendí el audio, ¿me lo escribís?"). The cause is
   logged (`voice_unusable`) and kept in the audit. Only the 30 s deadline is the failure path ("No pude procesar tu mensaje").
3. Usable: the transcript replaces the text. The context tells the model it is an automatic transcript that can be
   misheard; `contextFacts` and `checkSay` take it as the person's message, so the model may repeat a number the person
   said and no other.
4. The reply is the usual one; when it has no record of a change it starts with `🎙️ "<transcript>"` (code, cut at 80
   characters; see the live test round 2). The next message's window shows `[audio] <transcript>`.
5. A voice note is never the bare answer to a question: "el segundo" by voice goes to the model, which sees the options.
   Code does not delete or correct on what a speech model thought it heard (decision beyond the brief, one more model call).

### The confidence gate

Whisper writes something for any sound. Ticiano's beatbox note came back, on different draws of the same file (Groq is not
deterministic even at temperature 0), as ".", "¡Hola!", "Chika-chika, chika-chika", "Subtitulado por…", "¡Gracias por ver
el video!", "Fuerza del Vigilio". `judgeTranscript` refuses on the `segments` (weights are the segments' durations):

| signal             | good speech (3 real notes) | noise (beatbox, 42 draws)                  | refuse when                                               |
| ------------------ | -------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| avg_logprob (mean) | -0.18 to -0.25             | -0.18 to -2.85, most under -0.4            | mean under -0.4, or one segment under -1.0                |
| compression_ratio  | 0.76 to 1.06               | 0.2 to 2.26 (the "chika" loops 1.7 to 2.3) | any segment over 1.5                                      |
| no_speech_prob     | 0.001 to 0.008             | 0.16 on every draw                         | mean over 0.1                                             |
| text               |                            | "."                                        | no letter or digit, no segments, or over 1,000 characters |

Each threshold sits between the good notes and the noise, and together they refused all 42 draws seen (the first
version of the thresholds, -0.5 / 1.8 / 0.6, let two of the first ten through). Written risk: three good notes
are not many. A noisy room or a mumbled note can sit near -0.4, and a refusal costs the person one retyped message;
a hallucination that passes ("¡Hola!" at -0.46 would have) costs a harmless reply, and the 🎙️ line shows what was heard.
Widen with care, and rerun `pnpm tsx evals/voice-probe.ts` on new notes first. A synthetic note, "No, fueron cuatro mil."
by a computer voice, was heard as "Si no, fueron cuatro mil." at -0.46 and refused: the right call for that transcript.

### Results

- Real notes (local only, `evals/voice-probe.ts`; the audio is not in the repository):

  | note          | transcript                                                               | avg_logprob / ratio / no_speech | gate                                                                                       |
  | ------------- | ------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------ |
  | r51           | "Gasté 3.500 en café, 8.000 en el súper y 10.000 con la visa en el YPF." | -0.18 / 1.06 / 0.003            | pass                                                                                       |
  | r52           | "No, en YPF fueron 10.500."                                              | -0.23 / 0.76 / 0.002            | pass                                                                                       |
  | r53           | "¿Cuánto va este mes, más o menos?"                                      | -0.25 / 0.84 / 0.008            | pass                                                                                       |
  | r54 (beatbox) | "Chika-chi, Chika-chi, Chika-chi, Chika-chi."                            | -0.60 / 1.91 / 0.160            | refused; 20 more draws: 20 refused (13 low confidence, 5 repetitive, 1 no speech, 1 empty) |

- Scenario eval, `pnpm eval:scenarios --split all` (124 scenarios: the 117 of B2, s118 to s123 voice with synthetic
  Paulina and Mónica notes, and s124 for live #70), Haiku 5.5: **121/124 fully right (97.6%)**, dev 95/97, test 26/27
  (held out), **0 silent wrong changes, 0 invented numbers, 0 unnecessary questions**; the 6 voice scenarios 6/6 (the
  noise clip s121 is answered by code, no model call, and writes nothing). Dev misses: s061 ("la segunda", model
  variance, see below) and s117 (the older-item search; both are in the B2 notes as unstable). Per turn p50 1,464 ms,
  p95 3,008 ms; the 7 voice turns p50 2,168 ms (the transcription adds about 0.7 s to a model turn of about 1.4 s).
- Latency by tag, p50 ms, dev split, B2 against this run (no tag moved by more than +100 ms; the gate is +300):

  | Tag            | B2    | voice slice |
  | -------------- | ----- | ----------- |
  | logging        | 1,518 | 1,429       |
  | correction     | 1,497 | 1,476       |
  | deletion       | 1,546 | 1,512       |
  | answer         | 1,677 | 1,490       |
  | query          | 1,422 | 1,456       |
  | multi-action   | 1,603 | 1,679       |
  | older-item     | 2,718 | 2,815       |
  | typo           | 1,699 | 1,416       |
  | time-reference | 1,590 | 1,560       |
  | other          | 1,369 | 1,391       |
  | voice (new)    |       | 2,168       |

- Single-message eval, `pnpm eval --split all` (152 cases): 151/152 (99.3%), 0 silent amounts, 0 silent targets, p50
  1,436 ms, p95 3,213 ms; the one miss is c098 (dev, a category of a query).
- Tests: 463 passed (B2: 389), with the fake transcription endpoint injected like the fake Graph: a good note, each way the
  gate refuses, a service error, a bad answer, the budget, the deadline (and the abort reaching the call), an oversized
  or wrong-type file, the 🎙️ line and the window entry, the transcript as a source for the numbers check, nothing stored.
  The request itself (the `provider` pin, the language, `verbose_json`, the key) is tested against a fake `fetch`.
- Mutations (each broken alone; 39 mutations over the gate, the size cap, the time budgets, the pin and the voice path,
  and the two follow-ups): 39 killed. Three survived the first pass (the too-long check, and the deadline not reaching the
  transcription or the download, which the race at the deadline hid) and got tests.
- Spend: about US$0.25 of US$0.60 (scenario runs US$0.14, `pnpm eval` runs US$0.08, transcription about US$0.03 at
  US$0.0003 a note).

### B2 follow-ups from the live test (#66 to #72)

- **#72, the text that restated the line.** "Corregí el café de las 11:11." beside "✓ Corregido: Café $1.500 (antes
  $3.500) · 11:11". `composeReply` now drops a text whose words are all filler or already in the lines code rendered
  (`restates`, audit `text: dropped`, "only restates the lines"). A `reply` is never dropped for this: its words are the
  answer. Kept in code, not the prompt: no change to the cached prompt for it.
- **#70, `ask_user` with `after_answer: correct` and no `changes`.** Not fixed by accepting it as `none` in code: tried,
  and s061 ("cambiame lo del almuerzo a 5000" then "la segunda") went from 6 of 10 passes to 0 of 10, because the model
  omits `changes` in that case too, and the refusal is what makes it send them. So the rejection stays (a second model
  turn, about 1.5 s, in a rare case) and the prompt's "gave no change" example now includes "cambiemos el gasto de
  café". #70 did not reproduce offline: 16 runs of a two-café ledger, 0 refusals with or without the example; the new
  scenario s124 pins the one-turn answer. A stronger sentence in the prompt ("correct always carries changes")
  made s061 worse (2 of 10) and was dropped.
- **Where the live time goes (p50 2.45 s, p95 3.75 s over 12 messages).** The model turn is about 1.5 s (p50 of 99 one-turn
  messages in the eval, 1,505 ms) and the send through Meta 0.5 to 0.7 s, which the eval's fake Graph does not include:
  that is about 2.1 to 2.2 s before anything else. The rest is the second model turn: 11 of 113 dev turns (10%) used
  two (p50 3.2 s against 1.5 s): a search before a write, a repaired text or a refused call. That tail is p95. The
  rejected `ask_user` is a case of it, but one message of the 12. So p50 over 2.0 s is the send plus the model, and
  p95 under 4.0 s holds; getting p50 under 2.0 s would need a faster model call or a faster send, not a change in
  the loop. Not chased further, as asked.

### Open

- Not deployed and not tested against real Meta: the live test of a real voice note (the media lookup and download of
  `audio/ogg; codecs=opus`, the allowlisted hosts) is the orchestrator's. The `voice_unusable` log line names the cause.
- `OPENROUTER_API_KEY` must be set on the Railway service for voice to be on; without it a note gets the request for text.

### Review round (Opus 5.5), fixed on the same PR

- **A reply that cannot be sent after its changes were committed is a silent write.** WhatsApp refuses a body over 4,096
  characters with a permanent 4xx. The reply starts with the 🎙️ line, so a long note made it reachable. `fitReply`
  (`render.ts`, called by `composeReply` for voice and typed messages alike) holds the reply under 4,000 characters:
  what was heard is shortened with "…" first (never under 80 characters), then the model's texts go, then long bulleted
  lists are collapsed to their first items and "• … y N más" (the header still says how many), then lines that still
  do not fit end as "… y N más", and one line that is alone too long is cut. The record of a change is never dropped
  without being counted. It cuts by UTF-16 units, never inside an emoji. `GATE.maxChars` is 1,000 (a message logs at
  most 10 movements, about 60 spoken characters each; 1,000 is over a minute of speech): a longer transcript gets the
  "too long" notice (`REPLY_VOICE.too_large`).
- **The gate fails closed.** Every check is written `!(x >= min)` / `!(x <= max)`, so a NaN (extreme `start`/`end`
  overflow the duration weights) refuses instead of passing. The Zod schema takes only finite numbers in the ranges the
  service keeps (avg_logprob at most 0, compression_ratio at least 0, no_speech_prob 0 to 1), and the lowest and
  highest segment use `reduce`, not a spread, so 300,000 segments do not throw a RangeError.
- **Scenario grader.** `invented` compares amounts by value: "$5000" for the person's "5000" is not invented (a model
  reply that quoted it that way failed the dev gate twice in a row on s061; `checkSay` had allowed it).
- Mutations of the new code: 19 of 19 killed (the cap in `fitReply` and in `composeReply`, the limit, the order of
  what is shortened and dropped, cutting by code points, `maxChars`, each fail-closed check, the schema ranges, the
  spread, the `too_long` notice, and awaiting the transcription before the database reads).

### Follow-ups for the overhaul (not done here)

- Move `hear` and its notices out of `process.ts` into a `voice.ts`.
- Thread `heard` through `Worked`, `Commit`, `ExecuteInput` and `composeReply` as one value, not four.
- One list of the message kinds that get a reply (`text`, `image`, `audio`), instead of the copies in `process.ts` and the two
  conversation queries in `store.ts`.
- Strip the 🎙️ line from the conversation window (the transcript is there twice: `[audio] …` and in the reply).
- Warm the OpenRouter connection at startup, as for Anthropic: the first note of a process takes about 1.6 s, later ones 0.7 s.

### Live test round 2 (inbound_message #73 to #80) and its fixes

What worked: multiple logs, a correction and a question by voice. What did not:

- **The 🎙️ line was noise.** A reply that logged, corrected or deleted already shows what Warren understood, amounts
  included. Now `execute` hands `composeReply` the transcript only when no step was an `applied` log, correction or
  deletion (answers, summaries, questions, the model's own words, and a change that did not apply keep it), and the
  line is cut at 80 characters with "…" (`MAX_HEARD_CHARS`; the whole transcript is still the message and is stored in
  `body`). This also removes the duplicate in the conversation window for the common case. The scenario grader reads a
  reply's question-ness after the 🎙️ line.
- **A narrowed question looped (#76, #78, #79).** The question had one option (`asked` of length 1, nothing pending).
  "a ese ponele 3500" got an `ask_user` over that same movement with the change attached (after a rejected first try), and
  "ese" reopened three options. Fixed in three places, so that no single one has to hold:
  1. `resolve.ts`: "ese", "ese mismo", "sí, ese" and "sí" after a one-option question with nothing pending are answered by
     code with "¿Qué querés cambiar? <that movement>" and no model call (a bare "1" still goes to the model; with a pending
     action they are a yes to it). Typed messages only: voice goes to the model.
  2. The context line for a pending question with one option says so (volatile context, not the frozen prompt): a change in
     this message is `correct_movement` on that id, no change is `ask_user` on that same id with `none`, never other options.
  3. `calls.ts`: an `ask_user` over exactly that one id, `after_answer: correct` and `changes` becomes the
     `correct_movement` (no second turn). At no risk: the person saw that one movement and gave the change.
- **The rejected `ask_user` (#76, #78, #79).** `after_answer: correct` without `changes` is accepted as `none` when the
  person's message has no amount, in digits or in words ("cambiemos el valor de uno de los YPFs"): there is no new value, so
  the question is the right answer. With an amount in the message the model left the change out (s061) and the call is still
  refused, with a reason that says what to send ("send the new value the person gave in changes, or after_answer none if they
  gave none"). Last round's blanket acceptance broke s061; this one keys on the message. Written risk: a change with no
  amount (a payment, a date) left out by the model is now a question instead of a retry.
- **Measured** on the dev scenarios (the 4 voice and 2 narrowed-question ones added this round included), turns that needed a
  second model turn: before 13 of 120 model turns (10.8%), and 7 of the 15 questions; after 8 of 122 (6.6%), and 4 of 16
  questions. Plain questions (s124, s125 to s128's first turns) are one turn.
- **#77, a data point for the gate (not audio, which stays with Ticiano).** A 2-second note answering the narrowed question
  came back "S por L, 3500." (avg_logprob -0.58, compression_ratio 0.65, no_speech_prob 0.0) in 4 of 4 re-runs and was
  refused as low confidence. The meaning was lost, so refusing was right, and it shows -0.4 is not too strict (a fourth real
  data point beside r51 to r53). A computer voice saying "A ese ponele tres mil quinientos." went the same way ("AS con
  L3500.", -0.54): "ponele" is what Whisper misses. The vocabulary prompt now ends "ponele, cambiale", which made that clip
  "A ese ponele 3500." (pass) and left the real notes r51 to r53 unchanged and the beatbox note r54 refused on 25 of 25 draws.
  Not verified on #77's own audio.
- Scenarios: s125 (#76 to #78, typed), s126 ("ese" alone, then the change), s127 (the change by voice), s128 ("sí, ese mismo"
  by voice), s129 (the same on two cafés, test split). The voice scenarios s118 to s123 now expect no 🎙️ line where something
  was logged or corrected, and the line where there was a summary.
- Results: scenario eval `--split all` (129 scenarios): 129/129 fully right, dev 101/101, test 28/28, 0 silent wrong changes, 0
  invented numbers, 0 unnecessary questions; voice 8/8. (The dev run before this round's last edits had 99/101: s060, which passed 8 of 8 re-runs with and
  without the change, and s117, both known model variance.) Latency per turn p50
  1,611 ms, p95 3,184 ms; by tag the p50 moved within the run-to-run band except older-item (3 or 4 turns, n of 5) at 3,184 ms
  against 2,718 in B2. 477 tests (round 1: 463). 19 mutations of this round's code (the line's condition and which tools count,
  the 80-character cut, the one-option guard and its wiring, "ese", the bare-number guard, the context line, the amount check in
  digits and in words, keeping `correct` on an accepted question): all killed after two tests were added for what survived (a
  deletion without the line, and a change that did not apply keeping it).

## Agent slice C notes (2026-11-21)

Built on branch `agent-undo`, on top of B2 (#42) and the voice slice (#43). A person says "deshacer" and Warren reverts the
last batch of changes: all that one message logged, corrected or deleted, in one step, with a record rendered by code.

### Decisions

- **The action log is the data already stored; no table.** What batch X changed is exact and cheap to read from three
  columns that the commit point already writes: the rows with `inbound_message_id = X` (a row with a predecessor, a row that has
  another row's `superseded_by` pointing at it, is a correction's new row; one without is a log) and the rows with `deleted_by = X`.
  Per-movement outcomes (`logged`, `corrected` from old to new, `deleted`) are a query, not a copy, so they cannot disagree
  with the ledger. A `batch`/`action` table would have been a second source of truth to keep in step with the first.
  Migration `009_undo.sql` adds only the marks an undo needs: `inbound_message.undoes` (on the message that says "deshacer",
  the batch it reverted; unique, so a batch is undone once whatever races) and `movement.restores` (on the row an undo inserts to
  bring back a deleted one). Three partial indexes make the lookups cheap (`deleted_by`, `superseded_by`, `(wa_id, id DESC)`).
  Both columns are nullable and unset on every existing row. A test applies 009 on top of 001–008 with a log, a corrected row and
  a deleted row in the database and shows every row unchanged, then the constraints.
- **What a batch is.** A committed message of the sender (it has `action` and a stored reply) that inserted or deleted a movement of
  the account, is not itself an undo (`undoes IS NULL`) and has not been undone. A seeded movement (a message with no `action`) is
  not a batch, so a person with nothing of their own to undo is told so.
- **Append-only undo** (rule 3), by what the batch did:
  - _log_ → the row is soft-deleted (`deleted_at`, `deleted_by` = the undo message).
  - _correction_ (old O → new N) → a **new row with O's values supersedes N** (O → N → R). Chosen over un-superseding O because
    that would clear `O.superseded_by`, erasing the fact that N existed, and would need N deleted on top. The new row copies O's
    logged time (`created_at`), confidence and every value, in SQL, so "restores" is exact. The live queries, the recent list and
    the summaries are untouched: R is an ordinary live row.
  - _delete_ → a **new row copying the deleted one**, with `restores` = the deleted row's id. The deleted row stays deleted (a delete
    is never undone in place; `movement_one_ending` stays as it was). It keeps the original logged time.
  - The undo is itself a recorded batch: its rows have `inbound_message_id` = the undo message, its message has `action = 'undo'`,
    `undoes` = the batch, and the audit entry says `undid batch 12: logged 41, corrected 43`.
- **A second "deshacer" undoes the batch before; it never redoes.** It is how every editor behaves ("deshacer" twice goes back
  twice), and a redo that a person did not ask for ("rehacer", not offered) would silently re-apply what they just took back. Batches
  already undone and undo messages are skipped, so the order is a stack: the newest batch that is not undone. To get a thing back,
  the person says it again (or "borrá"/"anotá"); an undo of an undo is not offered. When nothing is left: "No tengo nada para deshacer."
- **The stale-state guard (all or nothing).** Every movement the batch touched must be as the batch left it. Where a movement stands now
  is found by following it forward (`superseded_by`, or `restores` after a delete); it is as the batch left it if its last row is live
  and every step after the batch's own row was made by an undo or by a batch that was undone. That last part is what lets a second undo
  reach a batch whose movement was corrected and then restored. If anything else changed it (a correction or delete by a batch not
  undone, or by hand), the whole undo is refused, nothing is written, and the reply names the movements: `No deshice nada: Café
  $3.500 cambió después. Decime qué querés cambiar.` It is never partial. In ordinary use the stack makes this unreachable (the later
  change is the newer batch, and is undone first), so it fires for a race and for changes made outside a batch; both are tested.
- **Transaction and locks.** The undo runs in `execute`, inside the commit transaction after the guard row. It takes a per-account advisory
  lock (two undos of one sender never interleave: the second reaches the batch before), then a `FOR UPDATE` on every row the batch
  touched, then reads where each movement stands (after the locks, so a concurrent change has committed or waits), then `lockLive`
  on each head before writing. A correction racing an undo of the same movement: the first to lock wins; if the undo does, the correction
  gets "ya fue corregido o borrado"; if the correction does, the undo refuses with the stale reply. Both orders are tested on a real Postgres.
  Known, not fixed: the undo locks rows in id order, a multi-correction message in action order, so two overlapping processes (never one:
  a sender's messages are queued in order) could deadlock. Postgres aborts one and that message gets the failure notice (review, 2026-11-21).
- **Code's bare "deshacer" is narrow** (review fixes). Only when no question is open (an open one, "deshacer" most likely means "never
  mind": the model reads it), and never with "no"/"mejor" before the verb ("no deshacer", "mejor no anular") or "el último" as the object
  (it names one movement; a batch may hold several). Those go to the model.
- **Time limit: 24 hours** from the batch's message (`received_at`, to the asking message's). Past it nothing is touched and the reply says so:
  "Lo último que hice fue hace más de 24 horas y ya no lo deshago solo. Decime qué querés corregir o borrar." The undo does not reach past an
  expired batch to an older one (older is older still).
- **Only the sender's own.** The batch is found by the sender's `wa_id`, and every row read or written is filtered by `account_id`.
  Another sender saying "deshacer" gets "No tengo nada para deshacer" and does not use up the first person's batch (a test checks that
  it is still undoable).
- **The agent.** `undo_last({text})`: `text` is the same nullable the other tools carry (a union: 10 of 16 allowed, 22 of 24 optional parameters, the same as before),
  for the part of a message the model did not do. No id, no batch reference: the model cannot aim it, so there is nothing to guard on
  its input; code decides which batch. It goes alone: with another action in the turn it is refused (the model is told and sends again),
  because the other action would be part of "the last thing". A typed bare "deshacer", "deshacé lo último", "volvé atrás", "anulá lo
  que hiciste" is `undoRequest` in `resolve.ts` and runs in code with no model call (13 ms); the pattern takes a verb, an optional "eso/lo
  último/lo que hiciste" and a "por favor", and nothing else, so "deshacé el café", "deshacé todo" and "anulá el súper" are not taken.
  By voice it always goes to the model, like every voice answer. "no, eso no" is the model's, with the conversation: right after a
  record it is an undo; after a question of ours it answers the question.
- **"deshacé el café" is not an undo.** The prompt says so, with an example, and tests, scenarios s134 and s139 (a different wording,
  held out) check it. "uh no, eso no iba, borralo" has its own verb about one movement and is a delete (the first version of the
  prompt took it for an undo, 6 of 6, and the single-message case c094 showed it; s145 reproduces it, 6 of 6 right after the fix).
  "deshacé todo" is a `reply` that says Warren goes back one step at a time.
- **Rendering** is all code, through `composeReply`/`fitReply`: `↩︎ Deshice: Súper $5.000 · Panadería $3.000` for undone logs; a bulleted
  list otherwise (`Café $3.500 (estaba $3.800)`, `Quité Subte $1.200`, `Volvió Súper $12.000`), which `fitReply` collapses like any
  list (a test undoes 300 deletes and the reply stays under 4,000 characters). The model's `text` may not contain `↩`, and "deshice /
  anulé / revertí" are claims that need this message's own undo (or an earlier `↩︎` record in the window, for a `reply`). The 🎙️ line of
  a voice note is left out when the undo applied, and shown when it was refused. The reply wording is not polished: Ticiano will refine it.
- **Scenario grading needed no new op.** An undone log is graded as the `delete` it comes to, an undone correction as a `correct` back to
  the old values and an undone delete as a `log`. The grader counts a reply that starts with `↩︎` as one that claims success, so a wrong
  undo is a silent wrong change like any other. New tag `undo`; the report prints the share of turns that needed a second model turn.

### Results

- Tests: 526 passed and 6 skipped (the real-Postgres file, which CI never runs; 477 before this slice). The new ones are `undo.test.ts` (41: a log, a multi-movement log, a correction, a delete, a mixed
  batch, a movement changed after the batch, all-or-nothing, another sender, the time limit and its edges, a second undo and running out, by
  voice, the model's path, the alone rule, what is not an undo, summaries and the recent list against independent SQL after each undo, the
  4,000-character cap, the audit), `migrations.test.ts` (009 over 001–008), render and say tests, and 4 tests in `concurrency.test.ts` on a real Postgres.
- Mutations of the guards, each applied alone and the suite run: killed unless noted.
  - Ownership: both lookups unfiltered (killed), every lookup unfiltered (killed). Each filter alone is redundant with the other (they survive alone, by design: two independent layers).
  - Stale-state: guard off (killed), later changes by never-undone batches ignored (killed), no walk through undone batches (killed: a second undo would refuse wrongly), head not required live plus no live lock (killed; each alone survives, two layers).
  - Time limit: no limit, 48 h, 12 h (all killed).
  - Append-only: undo of a delete clears `deleted_at`, undo of a correction rewrites in place, undo of a log removes the row, no supersede of the correction, no `restores` link, a new logged time on the restored row (all killed).
  - Stack: an undone batch not skipped, undo not marked, undo messages undoable, oldest instead of newest batch (all killed).
  - Agent: undo allowed beside other actions, the shortcut also taking a named movement, taking "todo", claims of an undo unchecked, `↩` allowed in the model's words (all killed).
  - Locks (real Postgres): neither row lock nor live lock (killed), no advisory lock between two undos (killed); the row lock and the live lock each alone survive (two layers).
- Real-Postgres suite with `PG_TEST_URL` (postgres:17 in Docker): 6 passed, including the undo first, the correction first (each forced by holding its locks), a random race for 6 rounds, and two undos at once taking two different batches.
- Scenario eval, `--split all` (145 scenarios: the 129 before and 16 new, s130–s145: 12 dev and 4 test), Haiku 5.5:
  **143/145 fully right (98.6%)**, dev 112/113, test 31/32, **0 silent wrong changes, 0 invented numbers, 0 unnecessary questions**.
  The undo scenarios (tag `undo`): **16/16**. Per turn p50 1,466 ms, p95 2,736 ms; the undo turns that code answers take 13 ms.
  **Second model turn: 17 of 179 turns that called the model (9.5%)** (the earlier runs of this slice: 8.9% and 7.9%; the undo turns
  that need the model take one turn; the second turns are the held searches and repairs of the older scenarios).
  The dev miss was a `reply` where an `ask_user` was expected (the "answer" tag, the variance B2 documents).
- `pnpm eval --split all` (152 cases): **150/152 (98.7%)**, 0 silent amounts, 0 silent targets, p50 1,476 ms, p95 2,357 ms. The same day, the same command on `main`
  gave 151/152, so one case of the difference is inside the run-to-run band of this model (the misses of this branch were in the held-out split; the dev
  case c094 "uh no, eso no iba, borralo" was one of them before the prompt rule above).
- Pre-existing flake, not from this slice: s117 ("borra el super y la nafta fue 7000", a súper older than the list) fails about 2 of 8 runs on `main` too
  (the model deletes the "pan" for being supermercado). A rule that says "match the words against the description, not the category" made it
  search first and then pick a wrong id for the nafta (4 of 10), so it was reverted. Left as it is.
- Scenario defects found and fixed on dev: s137 and s144 said "con la visa/débito" after two movements, which the model reads as both (not a
  product bug); the payment is out of the text.
- Model spend: about US$0.7 by the printed per-run costs (scenario runs about US$0.54, `pnpm eval` runs US$0.17 including one on `main`), over the US$0.50 of the brief:
  the overrun is the s117 investigation and the comparisons against `main`. Nothing was deployed and nothing outside the repository was touched.

### Open

- Not deployed and not tested live: a real "deshacer" through Meta is the orchestrator's. Migration 009 runs at startup (additive, nullable).
- `restores` is read only by the chain walk; nothing shows it to the person. A later slice may want "volvé a poner lo que deshice" (a redo), which this model can carry (the undo
  message names what it undid) but does not offer.
- The undo does not look at `confidence`/photos: an undone photo log is a log like any other.

## Agent slice D notes (2026-11-21)

Built on branch `agent-summaries`, on top of undo (#44). A person asks, by text or voice, for a total over any days, split by
category, payment, day, week or month, or compared with another range, and gets a code-rendered reply. The model chooses the days,
the split and the filters; it never computes a total, a difference, a percentage or an average (rule 1). `AGENTS.md`
("Summaries") describes the result.

### Decisions

- **The tool: `period` became a `range`, plus `group_by`, `compare_to` and `other`.** `summarize` is now `{range, group_by,
  compare_to, other, direction, category, payment, description, text}`. `range` is always `{period, month, year, from, to}`: a named
  period (the old seven, plus `weekend`, `last_weekend`, `last_year`), or `month` (a month number, year optional), `year`, or
  `dates` (`from`/`to`). A field a period does not use is `0` or `""`, and a stray one is refused ("period this_month takes no
  month"): a month number beside `this_month` means the model misread the question, and ignoring it would answer a different one.
  Named periods stay as shortcuts, so "este mes" is still one token of the enum and the common questions did not get harder.
- **The strict-tool limit is the grammar, not only the two counts.** B2 counted 24 optional parameters and 16 union types. Slice D
  stays inside both (23 optional, 10 unions: `other` is required, and the unused fields are sentinels, not nullable). But the API
  also refuses a tool list whose _compiled grammar is too large_ ("The compiled grammar is too large, which would cause performance
  issues"), a limit nothing in the schema counts. It was measured by sending the real tool list, 1 token of output, one variant at a time:
  - range + `group_by` + `compare_to` + a second typed range as an optional object (5 fields): refused;
  - the same without the second range: accepted;
  - a second range as two integers (`other_month`, `other_year`): accepted; as those plus two strings (`other_from`, `other_to`): refused;
  - a second range as **one string**: accepted, and accepted again with one more string beside it.
    So the list has room for about one more string field, and nothing else. The second range is therefore a short text, `other`,
    that code parses (`parseOther`): a named period (`last_month`), `month:9` or `month:9:2025`, `year:2025`, or `dates:11-01..11-15`
    (`""` unless `compare_to` is `range`). A text that is none of these comes back to the model as the reason. The alternative that
    was weighed, a separate `compare` tool, would have added a whole second schema to the same grammar. **The next slice that needs a
  field here has to remove one first** (the `text` fields and the nullable filters are the candidates).
- **Dates are resolved by code, the way a person in Argentina reads them** (`src/range.ts`, pure, from the message's own time):
  - Weeks are Monday to Sunday. "El finde" is the latest Saturday up to today and the Sunday after it: on a Saturday it is that day so
    far, on a Sunday both days, from Monday to Friday the weekend just gone. "El finde pasado" is the latest weekend that is over.
  - A period that is not over ends today: "esta semana", "este mes", "en lo que va del año", and an explicit end after today
    ("del 1 al 30 de noviembre" on the 21st). The range shown is the range summed.
  - "El 5" (`dd`) is this month's 5th unless that is still to come, then last month's; a day that month lacks (31 in November) goes
    back to one that has it. "5 de octubre" (`mm-dd`) is the latest such day not in the future. "29 de febrero" is the last leap day
    (2024 from 2026; the century rule is tested). A bare month, "octubre", is the latest October that has started: in November
    it is this year's, in September last year's, and "diciembre" asked on 21 November is December of last year, which the prompt
    tells the model to send as it is (a first run had it answer "todavía no llegamos a diciembre", s161).
  - The start of a `dates` range is the latest such day up to today, and its end the first such day from it, cut at today when it has
    not come: "del 1 al 15 de noviembre" asked on the 12th is the 1st to the 12th (a first version resolved the end first and sent it
    to last November: found in review, tested). A range that wraps ("28 de diciembre al 3 de enero", "del 20 al 5") resolves its end
    first and its start before it. The same month written backwards ("11-20" to "11-05") is refused.
  - A range that has not started (a month or year in the future, days after today), a reversed one, or one over **731 days** (two
    years, including one leap day) is refused. The reason is written for the model, with what to tell the person ("Eso todavía no
    pasó.", with no number), and goes back through the normal refusal path, so the model words the answer and `checkSay` still
    judges its text.
  - A `dates` range that is exactly a calendar month or year is that kind (its "before" is the previous month).
- **"Previous" is the same stretch while the period runs (decided by the orchestrator after the first version).** `compare_to: previous`
  is the day before for a day, the same-length range before for a custom range, and, for a week, a weekend, a month or a year, the
  previous one **cut to the same stretch while the current one is still running**: on 21 November "¿gasté más que el mes pasado?"
  compares 1–21 November with 1–21 October (the same weekdays for a week, the same Saturday for a weekend, the same days of last
  year for the year so far). A shorter previous month clamps to its last day: on 30 or 31 March, February is 1–28 (1–29 in a leap year); on 29
  February the year so far is against 1–28 February of the year before. A period that is over is compared whole (October against all of
  September, and September against all of August, though it is shorter). A week, a weekend and a year need no case of their own
  (each ends where the one before ends); only a month does, because the one before can be longer. The reply names both ranges ("Noviembre
  (1–21, en curso)" and "Octubre (1–21)"). The first version compared with the whole previous month; the orchestrator
  asked for like with like. The full-previous-month total as context ("octubre completo: $X") was skipped: it needs a third SQL
  result and a line of its own per currency, which is more than one line. A comparison with a time grouping is refused.
- **SQL is the totals, always (rules 1 and 3).** `queryGroups` is the same filtered, live-only `matching` fragment as `queryTotals` plus
  a group key: category; payment, folded for case and accents (`Visa` and `visa` are one group, shown as written, none is "Sin medio de
  pago"); day; week (its Monday); month. Dates are cast to `timestamp` before `date_trunc`, which would otherwise go through the session
  time zone. Direction and currency are always in the `GROUP BY`: ARS and USD, spending and income, never mixed. A reply's header
  totals are their own query (`queryTotals`), not the sum of the listed groups, so a group list that is cut still has the right total.
  A comparison is two such results; no migration.
- **The difference and the percentage are code's, in integer cents** (`src/summary.ts`, `bigint`, no float). The percentage is the
  difference over what was before, in tenths of a percent, rounded half away from zero (`+6,3%` for 1 cent on 16, `-6,3%` for -1 cent), shown
  with the Argentine comma and no `,0` (`+20%`). A change of a cent on a large total rounds to `0%` and the amount beside it still says
  it moved. With nothing before there is no percentage and no division: "No hay gastos en Octubre (1–31) para comparar."; with
  nothing now it is a real `-100%`. A comparison of groups ranks by the range asked about, shows a group the other lacks against
  `$0`, and shows no percentage when the other is zero.
- **Rendering** (`src/render-summary.ts`, pure, through `composeReply`/`fitReply`): the range in words first ("Octubre (1–31)",
  "Semana pasada (9–15 nov)", "Hoy (21 nov)", "Del 1 al 15 nov", a year only when it is not this one, "en curso" when the period is not
  over), one block per direction and currency, the biggest 8 groups and "• … y N más", days, weeks or months in order, the newest 31 and
  "• … y N anteriores". The model's `text` is checked as before; the rendered lines are sources for its numbers. The wording is plain on
  purpose (Ticiano refines message shape later); this slice fixes correctness and clarity.
- **The old wording changed.** "Hoy gastaste $15.500" is now "Hoy (21 nov) gastaste $15.500", and "Este mes gastaste" is "Noviembre
  (1–21, en curso) gastaste": the days are always named, which is the point. About twenty assertions in existing tests and two scenarios (s079, s084)
  were updated. `this_week` is cut at today, so a total no longer counts a movement dated after today (none can exist: a
  date in the future is refused when logging); a test that seeded such movements changed accordingly.
- **Review round (Opus 5.5, fresh context), fixed on the same PR.** A date range whose end had not come went a year back (above);
  a year below 2000 in a full date reached `addDays` and threw inside `execute`, or queried another year (now "not a real day",
  years padded to four digits); `fitReply` cut a summary of several currencies as if it were one list and could eat its own
  "… y N más" (each direction and currency is now its own line and the markers are not bullets); the rules of a summary's days (the
  range, `other`, "previous", no comparison by time) were written twice, in `checkCall` and in `execute`, and are now one pure
  `planSummary` that both call; the time-group set, `GroupKey` and two date helpers were duplicated and are shared. Not changed:
  comparing a period in progress with a whole one (open, below).
- **Eval.** 16 scenarios, s146–s161 (10 dev, 6 test), new tag `summary`, graded on `reply.has` with the figures. The expected figures
  were worked out by a script that does not use the product's code, from the same seed. The report prints latency by tag as before.
  `evals/agent.ts` maps a range back to the named period it equals so the single-message cases keep grading `this_month` for "en noviembre".
- **Audit.** A summarize entry in `tool_calls` carries `detail`: the days that were summed ("2026-11-01..2026-11-21 vs 2026-10-01..2026-10-31 by category").

### Results (D)

- Tests: 638 passed, 6 skipped (the real-Postgres file). New: `range.test.ts` (a table of phrases to ranges for a fixed Saturday, 21
  November 2026; each day of the week for "el finde"; month, year and leap-day edges; Argentine midnight; every refusal),
  `summary.test.ts` (cents, rounding ties, no division by zero, floats that fail), `render-summary.test.ts` (labels, blocks,
  caps, a summary too long for `fitReply`) and `summaries.test.ts`. The last one builds a ledger through the real pipeline (two
  corrections, one of them moving a movement across a month end; a delete that stays; a delete undone; ARS, USD and income) and checks
  every total, group and comparison two ways: a literal worked out by hand, and an aggregation written another way (raw rows in
  any state, filtered and summed in code in integer cents, never the product's SQL). It also covers an empty range, a zero previous
  period, month boundaries, a leap day, 23:59 and 00:00 Argentine time, a future range, a reversed one, and a range over two years.
- Mutations (one at a time, the suite run, restored after each): **66 of 66 killed**, plus one equivalent mutant removed by deleting the
  redundant guard it mutated.
  - Arithmetic (25): the difference sign, rounding down instead of half up, the percentage sign dropped or its denominator wrong, the zero
    guard off, comma and sign in the percentage, cents not padded (in and out), more/less swapped, the comparison the wrong way round,
    the live filter off, the end or start of the range exclusive, currencies mixed, groups ranked backwards, payments not folded,
    weeks and months truncated wrongly, a cut one early, the oldest buckets kept instead of the newest, a group sort on the wrong
    range, USD printed as ARS, the wrong currency's total.
  - Period resolution (27): last week's offset, weeks starting on Sunday, the weekend's Saturday, "el finde pasado" not moving back, a period
    not cut at today, a month name picking next year or last year wrongly, "el 5" in the future, 31 in a 30-day month, 29 February in a
    year without one, days in a month off by one, the 731-day cap at 730 and 732, a reversed range allowed, a range starting today
    refused, a future range allowed, the previous month going back two or none, the previous custom range off by one or overlapping,
    the previous week off by one, a whole month not seen as one, last year two years back, stray fields accepted, the Argentine day
    turning over in UTC, month 0 or 13 accepted, the in-progress flag lost.
  - Guards, `other` parsing and labels (14): a refused range running anyway, `other` beside no comparison ignored, a comparison by time allowed, the second range
    not resolved or not parsed, `range` without `other` accepted, the forms of `other` too permissive (four ways), a label that names last
    week "esta semana", does not mark "en curso", or drops the year.
  - The fitReply test was checked the same way: re-joining the blocks into one line makes it fail.
- Scenario eval, `--split all`, Haiku 5.5, 161 scenarios (145 before and the 16 new), two runs of the final code:
  **159/161 (98.8%)** and **160/161 (99.4%)**; held-out test split 37/37 both times; the 16 summary scenarios (`summary` tag, 10 dev and 6 test)
  **16/16 both times**; 0 invented numbers, 0 unnecessary questions. Silent wrong changes: **1 in the first run and 0 in the second**. The
  one is s117 ("borra el super y la nafta fue 7000"), the pre-existing flake documented in the slice C notes (about 2 of 8 runs on `main`);
  it is not a summary scenario. The other miss in both runs, s114 ("me cobraste dos veces el café?", a dev scenario that is a
  `find_movements` answer), passed 4 of 4 when run alone on this branch and on `main`: its text was dropped by the numbers check
  ("doble registro" reads as a number word) only inside the full run. Per turn p50 1,698 / 1,949 ms and p95 3,107 / 3,565 ms. Second model
  turn: 13 of 197 turns that called the model (6.6%) and 15 of 197 (7.6%); in the summary scenarios alone, 0 of 12 in the first
  dev run. Latency by tag, the two runs: `summary` p50 1,944 / 2,506 ms, p95 3,076 / 3,932 ms; `query` p50 1,691 / 2,328 ms, p95 2,176 / 3,609 ms;
  `time-reference` p50 1,944 ms, p95 3,107 ms (run 1). A summary is one model call and one SQL pass (two with a comparison).
- `pnpm eval --split all` (152 cases): **150/152 (98.7%)**, 0 silent amounts, 0 silent targets, p50 1,621 ms, p95 2,870 ms. Slice C's
  run was 150/152 as well; the dev miss was c085, the test misses are not printed. An earlier dev-only run: 120/121 (c098: "cuánto gasté en
  nafta el mes pasado" answered with the description filter, not the category).
- Like-with-like follow-up: tests 644 passed (6 skipped). New tests cover the clamp (28, 29, 30 and 31 March against February, 2026 and the
  leap 2028; 30 and 31 days against shorter and longer months), the year so far (including 29 February into a year without one), a week and
  a weekend in progress, and a finished month, week, year, shorter than the one before; two through the pipeline (30 and 31 March, the
  year so far, Wednesday of a week), against independent sums. Mutations of the clamp and the in-progress condition: **13 of 13
  killed** (the clamp removed or against the wrong month, a month in progress compared whole, a finished month cut, any month treated as in
  progress, the year clamp, year/week/weekend compared whole, the weekdays shifted by one, the in-progress flag never, always, or at the
  end day); two more survived as equivalent mutants and were removed by deleting the branches. `pnpm eval:scenarios --split dev --only` the
  11 dev summary scenarios: **11/11**, 0 silent, 0 invented, 0 second model turns, p50 2,021 ms, p95 2,873 ms, US$0.0066 (s153 now expects
  "Octubre (1–21)", "$67.000" and "+97%"; s158, s154 and s148 name their second range, which stays whole).
- The first real run of the new schema failed every message: the grammar was too large (see Decisions). It was found by the
  scenario run, before any other check, and led to the shape above. Warm-up: the first request after this change compiles the grammar
  (about 10 s, seen as a 14 s turn in the first dev run); the server's startup warm-up covers it.
- Model spend about US$0.34 by the printed per-run costs (scenario runs US$0.0065 + 0.054 + 0.069 + 0.068 + 0.0066, `pnpm eval` runs 0.036 twice
  because one dev run was repeated by mistake, + 0.047, probes and reruns of s114 about US$0.01). Nothing was deployed and nothing outside the repository was touched.

### Open

- **Sliding windows** ("los últimos 7 días", "en los últimos 3 meses") are not a period. The prompt has the model send `dates` from
  the 14-day calendar for up to two weeks, and the label shows the days; beyond that the model should use a month or ask.
- **A second explicit range as days** works (`dates:11-01..11-15`) but is the least tested path with the model.
- The grammar budget (above).

## Speed pass notes (2026-11-22)

Branch `agent-speed` on top of summaries (#45). The goal was the live answer time: received to reply sent p50 2,352 ms and p95 4,065
ms against targets of 2.0 s and 4.0 s. Nothing here changes what the agent decides; rules 1 to 4 hold, and the model is still Haiku 5.5.

### Where the time goes (measured, not guessed)

- **A model call is a fixed cost of about 0.8 s (not strict) to 1.2 s (strict), and the output is nearly free.** Same warm request, same
  17,240-token cached prefix, `evals/cache-probe.ts strict --n 10` (interleaved, from a Mac in Argentina): `hola` (24 output tokens) p50 1,170 ms;
  a log (132 tokens) p50 1,400 ms. That is about 2 ms per output token, so cutting 30 tokens is worth under 0.1 s. Cutting the cached prefix by a
  third (17k to 11.7k tokens) moved a call by 0 to 0.2 s. The tool schema's fields, `"text": null` and the sentinel fields are not where the time is.
- **Strict tools cost 0.2 to 0.33 s a call.** The same probe with `strict: true` on every tool (what shipped) against none:
  `hola` p50 1,170 vs 842 ms (mean 1,304 vs 967), log p50 1,400 vs 1,185 ms (mean 1,433 vs 1,224). It is the biggest single lever, on every call.
  Strictness was never a correctness guard: `checkCall` parses every input with the zod schema and checks every value
  (amounts, dates, ids, the numbers in the model's words), and refuses a bad one with its reason. In the final full run (strict off, 174 dev turns) no
  model input was refused for its shape (the dev audit has only a repaired text and a text without a tool); one `summarize` call was refused in the held-out
  test split, whose reason is not printed (a range the guard refuses, or a shape: not known). The cost of the change: an input that does not fit (a category outside the list, a missing key) is now a refused call and a second turn,
  where strict made it impossible. Watch `second-turn causes` in the scenario report and the audit's `invalid input` in `tool_calls`.
  A refusal's reason is one `path: reason` per failing field (never cut in the middle of one; see the review round), and a placeholder the model leaves out
  (`text`, a null filter, an unused range field) is read as its placeholder, so a bad shape is usually one fixable turn.
  The strict-mode limits in the slice B2 and D notes (24 optional parameters, 16 unions, the grammar size) no longer bind: a field can be added, or
  `ask_user.changes` made required, without removing another first.
- **A cache miss costs money, not time.** `evals/cache-probe.ts pairs`, 10 cold and warm pairs (a fresh nonce in front of the frozen prompt, so the
  whole prefix is written, then the same request again): cold p50 1,448 ms, warm 1,358 ms (the same pair: +63 ms mean, +91 ms median); time to first
  token 1,100 vs 1,079 ms; cost per call US$0.00228 cold vs 0.00030 warm (7.6x). With the 1-hour TTL, 4 pairs: cold 1,502 ms, warm 1,565 ms (noise: a
  slow warm call). So the live message at 22:42:43 that took 2,615 ms with `cacheRead 0` was mostly the ordinary spread of a call, not the miss.
- **The second model turn was the live "ask" problem, and it was `find_movements` on a ledger with nothing more to find.** In the instrumented baseline run
  (the code of `main` plus the timings), 11 of the 12 turns with a second model call were a `find_movements` search (the twelfth, a repaired text), and
  five of them were dev scenarios with 5 movements in total (s057, s060, s061, s063, s066): "borrá lo del almuerzo" on a ledger of five searches,
  finds nothing, and then asks. The list the model sees holds the 10
  newest, so with fewer than 10 it is everything the person has, and the search could not find anything the model had not seen. A person who has just started
  has a short ledger, which is exactly who the live test messages came from. The context now says so (`ContextInput.complete`: 1 to 9 movements; not for an empty
  list, whose rule is unchanged), and tells the model what "nothing fits" means without a search: "el X fue N" is a new expense, a change or a
  delete is a question. A first version of the line said only "follow the rules for when to ask", and "el almuerzo fue 5000" became a question instead of a
  log (s165): the wording above is the second. A ledger of 10 or more still searches for an older item (s075 to s077 stay two turns, as they must).
  The other causes are unchanged and rarer: a text the numbers check sends back (`log_movements:repair`, one per run), and a first `ask_user` with after_answer
  `correct` and no `changes` (s061 and kin: refused in 4 of 4 runs before, 0 of 3 full-wording runs after the two prompt edits, the `ask_user` description
  and the complete-list line; the two are not separated).

### What changed

| Change                                                          | Where                                                                                                                                                 | Evidence                                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-stage timings on every sent reply                           | `inbound_message.timings` (migration 010), `src/timings.ts`, `src/latency-report.ts`, `pnpm latency`                                                  | claim, reads, each model turn (call, searches after it, input/output/cache tokens, characters of text beside the calls), commit, send stamp, send; "other" is what is left |
| Tools not strict                                                | `tools.ts`                                                                                                                                            | -0.2 to -0.33 s per call, above                                                                                                                                            |
| 1-hour TTL on the frozen prefix                                 | `loop.ts` `CACHE_TTL`, also on the startup warm-up                                                                                                    | 5m: write after 330 s, 0 read (MISS); 1h: 17,233 read (HIT), same request. Cost below                                                                                      |
| The model is told when the list is everything                   | `prompt.ts`, `process.ts`                                                                                                                             | second-turn rate 7.1% to 4.0%; asks on short ledgers 2 turns to 1                                                                                                          |
| One read for the account                                        | `store.upsertAccount` (a SELECT, the insert only for a new person)                                                                                    | one round trip fewer per message; `reads_ms` will show it                                                                                                                  |
| `summarize` no longer echoes the question into `text`           | the tool description                                                                                                                                  | echo in 46% of summarize calls (11 of 24) to 0 of 39; about 4 tokens, mostly a cleaner record                                                                              |
| `ask_user` always carries the value with after_answer `correct` | the tool description                                                                                                                                  | first-turn refusal of s061 and kin 4 of 4 runs to 0 of 3 (with the complete-list line)                                                                                     |
| Scenario runner                                                 | `maxModelTurns` on a turn (a speed expectation, reported, not a failure), second-turn causes and output tokens per action in the report; s162 to s165 | `evals/scenarios`                                                                                                                                                          |

Tried and dropped: a "write nothing before or between tool calls" line in the system prompt. The model does write English reasoning before a
tool call on ambiguous messages (about 40 to 60 tokens: "There are two cafés ... the most recent is id=109"), but with the line it answered
with text and no tool call 1 to 2 times in every 7 scenarios (a whole extra turn, 0 of 4 runs without it), and output tokens per ask did not fall (148 vs 152). Not shipped.
Also not done: shrinking the schema (`text: null`, the summarize sentinels), because a token costs 2 ms; and a bigger recent list, which would remove
the search for the 11th to 25th newest movement but changes what "borrá el 2" is a position in. Both are in Open.

### TTL cost trade-off (Haiku 5.5, 17,240-token prefix)

Prices per million tokens: input 0.10, cache read 0.01, 5-minute write 0.125 (1.25x), 1-hour write 0.20 (2x), output 0.50. Prefix per call: read
US$0.000172; 5-minute write US$0.002155; 1-hour write US$0.003448. The cache is shared by every person (the prefix is the same bytes), so it stays warm as
long as anyone writes inside the TTL; the cases below are the worst one, a single person.

| Gap between messages                                   | 5-minute TTL                  | 1-hour TTL         |
| ------------------------------------------------------ | ----------------------------- | ------------------ |
| under 5 min                                            | read, US$0.000172             | read, US$0.000172  |
| 5 to 60 min (a person at one message per 10 to 30 min) | write every time, US$0.002155 | read, US$0.000172  |
| over 60 min                                            | write, US$0.002155            | write, US$0.003448 |

At one message every 10 to 30 minutes, the 1-hour TTL turns a miss on nearly every message into a read on nearly every message: US$0.00198 less on each,
about 12x cheaper on the prefix and 7.6x on the whole call. It loses (by US$0.00129 a message) only for the message that follows a gap of more than an
hour, so it pays whenever at least 40% of the gaps are shorter than an hour but longer than five minutes. The deploy's warm-up writes it once (US$0.0034). A keep-alive
that re-sends the prefix every 4 minutes would cost more per day than it saves at this volume, and the 1-hour TTL needs no scheduler. The latency gain is small (a miss is
about +0.06 s), so this is mainly a cost change.

### Results

Same 165 scenarios (161 before plus s162 to s165), real model and pipeline, per turn from post to stored reply (a Mac in Argentina, so a floor on the network
side and not a prediction of Railway). Before is `origin/main`; the second column is the same code with only the timings added (it shows the
run-to-run spread: a model call is not deterministic).

|                                                       | Before (main)                            | Before, instrumented                 | After                                                                             |
| ----------------------------------------------------- | ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Scenarios fully right                                 | 160/161 (99.4%)                          | 158/161 (98.1%)                      | **164/165 (99.4%)**; dev 128/128, held-out test 36/37                             |
| Silent wrong changes / invented numbers               | 0 / 0                                    | 0 / 0                                | **0 / 0**                                                                         |
| Per turn p50 / p95                                    | 1,606 / 3,080 ms                         | 1,497 / 2,557 ms                     | **1,141 / 1,854 ms**                                                              |
| Second model turn                                     | 14 of 197 (7.1%)                         | 12 of 197 (6.1%)                     | **8 of 201 (4.0%)**; dev 6 of 157 (3.8%) vs 11 of 153 (7.2%) before               |
| Second-turn causes                                    | n/a                                      | `find_movements` 11, repaired text 1 | `find_movements` 5, repaired text 1, text without a tool 1, refused `summarize` 1 |
| Output tokens per turn, mean                          | n/a                                      | 163                                  | 159                                                                               |
| Per action p50 (log / correct / delete / query / ask) | 1,595 / 1,516 / 1,403 / 1,857 / 1,566 ms | n/a                                  | 1,095 / 1,159 / 1,015 / 1,352 / 1,157 ms                                          |
| Per action p95 (ask)                                  | 3,245 ms                                 | n/a                                  | 1,509 ms                                                                          |
| Cost of the run                                       | US$0.0676                                | US$0.0675                            | US$0.0689                                                                         |

- Output tokens per action, before (instrumented) and after, mean per turn that called the model: log 149 to 154, correct 141 to 139, delete 93 to 96, undo 74 to
  74, query 257 to 261, ask 189 to 149, multi 225 to 221, other 113 to 84. They did not fall except where a second turn went away (ask, other); see "Where the time goes".
- `pnpm eval --split test` (31 held-out cases): 31/31, 0 silent, p50 1,106 ms, p95 2,161 ms. The full `pnpm eval --split all` was not repeated (the model budget
  of US$0.60 was spent): before it was 148/152 (97.4%), 0 silent amounts and targets, p50 1,507 ms, p95 2,549 ms, mean output 157 tokens, US$0.0472.
  The eval measures one message from a 10-movement list, so it does not see the complete-list change; it does see strict off and the prompt edits, and the test split held.
- Held-out test scenarios have one unnecessary question in the last run (0 in the baseline, 1 in the run between); the model is nondeterministic and read the same
  36/37 before strict was turned off. Not looked at (held out).
- Mutations (one at a time, the whole suite run, restored after each): **21 of 21 killed**, after tightening four tests that let a timing mutant live
  (the search time added over two searches, a second call timed from its own start, the commit, send and claim times, each with a delayed fake). The
  mutants: the complete flag at `<=`, on an empty ledger, and never; the account insert returning nothing on a conflict; the timings overwritten instead of merged;
  the search time reset per call; the call time taken from the start of the loop; output tokens dropped; a 5-minute TTL; the 1-hour write priced as a
  5-minute one or counted twice; `media_ms` always set; the commit, send and claim times zeroed; a cache miss read as a hit; the later calls
  including the first; "other" ignoring the send; the percentile off by one; strict back on; the complete line removed.

### Expected live effect

Live received to reply sent was p50 2,352 ms, p95 4,065 ms (the evals from here were p50 1,606, p95 3,080 per turn: the live number is about 0.75 s higher, the Graph send and the claim).

| Change                                 | Expected live saving                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Tools not strict                       | p50 -0.2 to -0.3 s (every message makes at least one call)             |
| Fewer second turns                     | p50 ~0; asks on a short ledger 3.75 s to about 2.7 s; p95 -0.3 to -1 s |
| 1-hour TTL                             | p50 -0.01 s; p95 -0.06 s; about 7x less spent on a missed message      |
| One account read, text echo, ask value | under 0.02 s together                                                  |

Estimate after: **p50 about 1.95 s (1.85 to 2.05), p95 about 3.3 s**, which meets the 2.0 s p50 target only just. The scenarios moved 0.47 s at p50 and 1.2 s at p95, of which about
0.1 s is the spread between two runs of the same code. The orchestrator measures it live: run `pnpm latency --last 40` after deploying and read "Where the time goes" (the
model call, the claim and the send should each now be separate lines; "other" is what is left).

### Open

- **The floor is the model call.** 0.8 s a call without strict, with 24 or 132 output tokens alike, from Argentina; from Railway the network part will be smaller, and
  the stored `model_ms` per turn says by how much. Nothing in the prompt, the schema or the output shortens it; a bigger lever is a faster model
  (the benchmark settled on Haiku) or fast mode where the model has one. Haiku 5.5 does not list it.
- **Older items.** A ledger of 10 or more still takes a search turn (about 1.3 s) for an item beyond the 10th newest. A longer list (20 or 25) would remove most of those searches for a few
  hundred tokens of uncached input; it changes the meaning of "borrá el 2" (the position in a longer list), so it needs its own scenarios first.
- **A text without a tool call** is still a whole extra turn (the loop says "answer only by calling a tool" and tries again). Its rate here was 1 in 201, on messages that
  are a bare answer; `timings.turns[].text_chars` shows it live.
- **The grammar budget** (slice D's "the next slice has to remove a field first") no longer binds; the sentinel fields (`month`, `year`, `from`, `to`, `other`) can become one optional string when someone wants the tokens (about 20 per summarize, 0.05 s).
- Not done, as the brief allowed: the DB reads were already parallel with the typing call (`reads_ms` and `claimed_ms` are measured now, so a slow query would show); the
  first-signal path was not touched.

### Review round (Opus 5.5, fresh context), fixed on the same PR

- **The refusal reason was cut mid-JSON** (`parsed.error.message.slice(0, 300)`, pretty-printed). A `summarize` that left out the unused range fields showed the model
  `month` and half of `year`, never `from`/`to`, so it fixed one field a turn and could reach the failure notice; strict made that impossible. Now `issueList` gives one
  `path: reason` per issue, joined with `; `, at most 12 and then "; and N more", never cutting one. And a field the model leaves out that has a placeholder is read as
  it (`text`, `payment`, the summarize filters and `other` as null or `""`, `month`, `year`, `from`, `to` as 0 or `""`), through zod `.default`, which the tools' JSON schema
  does not show (`tools.ts` strips `default`, so the model still sees every field required, and the cached prefix is the same bytes). Code validates the value either way.
- **Timings now cover failed messages**, the slowest ones: `recordFailure` stores the stages up to the failure (the claim and reads; the model calls of a run that ended
  with no valid action or cut off, through `AgentError.turnLog`; the commit time is absent as it never ran). `pnpm latency` counts them ("N of them with no reply sent") and leaves
  them out of "other", which needs a reply. Messages answered in code are left out of the "agent loop" line (they have no model turn).
- **`pnpm latency`** shows a negative "other" instead of clamping it, and includes photo and voice rows (the headline numbers stay the text messages'; the stage lines cover all three,
  so "photo / voice wait" can print). The default `--last` now counts all three kinds.
- Tests: the timing fields are asserted against delayed fakes (`reads_ms`, `commit_ms`, `send_ms`, the claim wait, the search time), the token fields against a response with known
  counts (`input`, `cache_write`, `text_chars`), and the failed paths (no valid action, cut off, deadline, commit failure) each store their stages. Mutations: **28 of 28 killed** (the
  refusal cut at 300, the "and N more" dropped, only the first issue, the path dropped, each default removed, defaults shown to the model, each failed path's stages dropped, the
  failure write removed, code-answered rows in the agent line, failed rows left out, the clamp back, the headline over every kind, media rows left out, and each of `reads_ms`,
  `text_chars`, `cache_write`, `input` zeroed). `schema.ts`'s comments no longer justify the shape with strict-mode limits.
- **For the overhaul (not done here):** with strict off, use real optional fields instead of required null/`""`/0 placeholders and a typed second range in `summarize`, then delete `parseOther`.
