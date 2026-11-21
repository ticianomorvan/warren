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

- Images, PDFs and voice notes. A later slice feeds them into the same `log_movements` tool.
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
- `undo_last` reverts the sender's last write batch, using a new `action` table (slice C).
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
