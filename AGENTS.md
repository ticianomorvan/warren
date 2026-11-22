# Warren

Warren is a WhatsApp expense agent for people in Argentina. A person writes "café 3500 y súper
12.000 con la visa, ayer 20 lucas de nafta" and gets one compact reply listing what was
understood. They fix it in plain words ("no, el café fue 3800", "borrá el último") and ask simple
questions ("¿cuánto gasté este mes en super?"). The spec, with its slices and the Slice 1 result,
is in `docs/spec.md`. The previous mail-ledger product is the tag `v0-mail-ledger`.

## Rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** A model never adds, converts or rounds money. Amounts are
   decimal strings ("3500", "1500000.50"); code computes every total.
2. **The model acts only through guarded tools.** A short agent loop (at most 3 model turns) calls typed
   tools; the write tools are terminal: code validates them, runs them inside the commit point and renders
   the record of every change from a template, with no further model turn. The model may add a short text
   of its own, but it never writes a number code didn't give it (`src/agent/say.ts` checks every number;
   a text that fails is dropped) and never replaces the code-rendered record of a change. It never picks a
   target in code's place: an id it sends must be one it was shown, the sender's, and live.
3. **Corrections never overwrite a movement, deletes never remove one, and neither does an undo.** A correction is a new
   row that supersedes the old one (`superseded_by`); a delete stamps `deleted_at` and `deleted_by`. Only movements that
   are neither count (the recent list, query totals). An undo is made of the same moves: undoing a log is a delete,
   undoing a correction is a new row with the old values that supersedes the correction, undoing a delete is a new row
   (`restores` names the deleted one). No row is edited, removed or un-deleted, and the undo is itself a recorded batch.
4. **Secrets live only in the gitignored `.env`.** Never in code, logs, eval output or commits.
5. **What Warren remembers about a person is only what they said, and is theirs alone.** A fact (`fact` table) is append-only like a
   movement: a new value supersedes the old row, a forget stamps `forgotten_by`, an undo inserts a new row. Code refuses anything that looks like
   a secret, any number the person did not write, and a key that is not their words; a fact never logs, corrects or deletes a movement; the model
   only ever sees its own sender's facts, in the per-message context and never in the cached prefix; forgetting everything runs only on the person's
   own "sí" to code's "¿Seguro?".

## Layout

```
src/agent/    The agent: schema.ts (tool inputs, categories, the range of a summary), tools.ts (the tool list, frozen; not strict),
              prompt.ts (frozen system prompt + the per-message context, with the person's facts, + `contextFacts`), calls.ts (the guards
              that need no database), memory.ts (pure: the rules of a fact: secrets, caps, the person's own words and numbers), loop.ts (the manual loop, warm-up, held writes, the photo block),
              say.ts (the numbers check for the model's own words: pure), validate.ts (the value rules),
              models.ts (Haiku/Sonnet configs, prices), index.ts
src/time.ts   The Argentine calendar day and clock, and date arithmetic
src/range.ts  Pure: a summary's range (a named period, a month, a year or explicit days) resolved to Argentine days, the range before it, and the refusals (not started, reversed, over two years)
src/summary.ts  Pure: the difference and the percentage of two totals, in integer cents (`bigint`), never a float or a division by zero
src/render-summary.ts  Pure: the reply to a summary (the range in words, totals, groups, comparisons), from SQL results only
src/server.ts Entry point: config, migrate, warm-up, startup sweep, 30 s sweep, HTTP server (`pnpm start`)
src/app.ts    node:http routes: GET /health, GET+POST /webhook (signature, dedupe, persist, 200)
src/store.ts  The rules of the tables (inbound_message, reply, account): due predicate, claim, the
              conversation window, the commit transaction (guard, then the actions' effects, then the stored
              reply and the audit), ownership-guarded writes
src/ledger.ts All SQL on `movement`: live movements (not superseded, not deleted), find, insert, lock,
              supersede, soft delete, summary totals and groups, and what undo reads and writes (last batch, a batch's rows, the chain of a movement, `copyVersion`)
src/movement.ts Pure: text normalizing, applying a correction's changes, which fields changed
src/facts.ts  All SQL on `fact` (agent slice F): live facts, remember (insert or supersede, capped, under a per-account lock), forget, forget all, and what undo reads
src/resolve.ts  Pure: `answerNumber`/`answerAction`, the bare answer to a question we asked (done in code, including the "sí" of "¿Seguro?" over forgetting everything), and `undoRequest`, a typed bare "deshacer" (done in code)
src/undo.ts   Undo of the sender's last write batch (agent slice C): which batch, the stale-state guard, the append-only reversal; runs inside the commit transaction
src/undo-facts.ts  The facts half of an undo (slice F): what the batch stored or forgot, whether each still stands as it was left, and the reversal
src/execute.ts  Runs a message's actions inside the commit transaction and returns the reply to store
src/process.ts  Per message: ignored vs reply; for text, typing + agent together, the 10 s interim note, the 30 s
              deadline, the commit point, the at-most-once send; drain on shutdown; the sweep
src/render.ts The reply templates (Argentine money format) and every canned text (help, photo and voice-note problems,
              the 🎙️ line, the fallback when the model's words are dropped); pure
src/transcribe.ts  Voice notes to text: the OpenRouter client (whisper-large-v3, pinned to Groq), the vocabulary prompt
              and the confidence gate (`judgeTranscript`)
src/test-harness.ts  Shared integration-test setup: PGlite (or a real Postgres), fake Graph (with media by id),
              fake transcription, fake Anthropic client (scripted tool calls), `setup()`, `photoBody()`, `voiceBody()`
src/command-fixtures.ts  Scripted tool calls, seeded movements and `say()` for the agent tests
src/http.ts   keepAliveFetch: a fetch with its own 60 s keep-alive pool (Graph and Anthropic)
src/whatsapp/ signature.ts (HMAC), payload.ts (Zod parse of webhooks, photos included), graph.ts (Graph API client:
              send, read and typing, and the photo and voice-note downloads with their limits)
src/config.ts Zod-validated env; src/db.ts postgres.js + migrations; src/log.ts JSON logs
src/migrations/  Plain SQL, `NNN_name.sql`, applied once at startup under an advisory lock
src/latency.ts  `pnpm latency` (the query and the print); latency-report.ts: the pure report, by action and by stage
src/timings.ts  The per-stage times stored on `inbound_message.timings` with every sent reply (claim, reads, each model turn with its tokens, commit, send)
evals/        cases.jsonl (dev/test split, one command per message), command.ts (that command shape), agent.ts
              (runs the agent on a case and maps it to a command), grade.ts, run.ts, results/ (gitignored but summary.md)
evals/voice-probe.ts  Local probe: real audio files through the real transcription service, printing the transcript and the gate verdict
evals/scenarios/  Multi-turn scenario eval: scenarios.jsonl (a scenario may seed `facts`, a turn may check `liveFacts`, carry an `image` or an `audio`, a file of fixtures/;
              `fixtures/make-voice.sh` makes the synthetic voice notes), schema.ts, grade.ts (database-state grading), drive.ts (plays a scenario through the real pipeline), report.ts (pass rate, latency by action and by tag), run.ts, results/baseline.md
docs/spec.md  Source of truth for what is built and in which order; docs/agent-spec.md the agent design
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome
pnpm typecheck
pnpm test          # Vitest, no network; real SQL on in-process PGlite, Graph API injected
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres pnpm test src/concurrency.test.ts
                   # also runs the real-Postgres concurrency tests (skipped without PG_TEST_URL; CI never sets it).
                   # Throwaway database only, it is truncated. docker run --rm -d --name warren-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17
pnpm start         # the server; needs DATABASE_URL, ANTHROPIC_API_KEY and the WhatsApp variables (see src/config.ts);
                   # OPENROUTER_API_KEY turns voice notes on (unset: they are answered with a request for text)
pnpm latency [--last N]   # p50/p95 received -> typing/reply, by action, then where the time goes (claim, reads, model turns, commit, send, tokens, cache misses), from DATABASE_URL (Railway: the Postgres public URL)
pnpm tsx evals/cache-probe.ts pairs|strict|gap   # real-API probes: cold vs warm prefix, strict vs not, the TTL after a gap (spends ~US$0.02-0.04 each)
pnpm eval [--model haiku|sonnet] [--split dev|test|all] [--concurrency N]   # one message at a time through the agent, needs .env
pnpm eval:scenarios [--split dev|test|all] [--budget 0.30] [--only s001,s002]   # multi-turn scenarios, real pipeline and model, needs .env
                   # (voice scenarios also call the real transcription service: OPENROUTER_API_KEY)
pnpm tsx evals/voice-probe.ts a.ogg b.ogg   # real voice notes through the real service: transcript, confidence numbers, gate verdict (never commit the audio)
```

`pnpm eval` spends money: tune the prompt on `--split dev` only and run `--split test` once per
model at the end. CI never calls the Anthropic API. Its cases are written as one command per message
(`evals/command.ts`); `evals/agent.ts` runs the agent on each and maps what it did into that shape (an
`ask_user` is a low-confidence command). The 5 cases that are only the pick of an option of a question
(`answeredByCode`) are code's job and are covered by unit tests, not measured on the model.

`pnpm eval:scenarios` does the same for conversations (PGlite, a fake Graph, the real model; stops before its
`--budget`, default US$0.30). It grades the database after each turn and gates on 95% fully right and 0 silent
wrong changes. Its test split is held out like the other: never print or tune on it. Baseline:
`evals/scenarios/results/baseline.md`.

## Conventions

- Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional
  Commit (`feat:`, `fix:`, `docs:`, `chore:` ...). Every commit is signed off: `git commit -s`.
  See `CONTRIBUTING.md`.
- Pin GitHub Actions by full commit SHA with a version comment; workflows default to
  `permissions: contents: read`. Never use `pull_request_target` with a checkout of the pull
  request.
- pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside
  `allowBuilds` (`pnpm-workspace.yaml`). Do not widen either without a reason in the commit.
- Node 24 (`.nvmrc`), TypeScript strict, Biome formatting, Zod 4 for schemas.

## Deploy

- Railway project `warren` (US East, Virginia: `us-east4-eqdc4a`), services `warren` (the app) and
  `Postgres`. Deploy by hand with `railway up -s warren` from the repo; there is no GitHub integration yet.
- Railway settings live in `.railway/railway.ts` (Infrastructure as Code, npm `railway` SDK): build, start
  `pnpm start`, healthcheck `/health` (60 s), restart on failure, 1 replica in US East, the domain, and the
  Postgres TCP proxy. Variables are unmanaged, so the file never holds secrets; set them with
  `railway variables`. Change the file, run `railway config plan`, then `railway config apply`. A plan that
  is not "already up to date" means someone changed the service by hand.
- **Single replica, single process.** The recovery sweep and the in-process worker assume it. The atomic
  claim stops a double send, but do not scale out without revisiting the sweep.
- The app reaches Postgres on the private network (`DATABASE_URL=${{Postgres.DATABASE_URL}}`). For
  `pnpm latency` from a laptop, build the URL from the Postgres service's `RAILWAY_TCP_PROXY_*` and `PG*`
  variables (a TCP proxy is enabled on that service). Never print it.
- Webhook host `wa.heywarren.app` (CNAME and TXT in Vercel DNS). The Meta subscription is set by API
  (`/{app-id}/subscriptions`, `/{waba-id}/subscribed_apps`), not in the dashboard.
- `ALLOWED_WA_IDS` (comma-separated, `+` and spaces ignored) is who gets a reply. `*` answers everyone (dev
  mode); empty or unset answers nobody. Every message is stored; the others end as `ignored`.
- **Meta test number:** it only delivers to its recipient list, matched exactly. Meta saves Argentine
  mobiles there without the `9` (and Mexican ones without the `1`), even when typed with it, while
  webhooks give `549…` / `521…`. `sendText` in `src/whatsapp/graph.ts` sends to the `wa_id` and, only
  after a 131030 (nothing was sent), retries once with the short form and remembers it for that number. A list entry typed with the local `15` is saved with it and
  never matches; re-add the number as `+54 9 <area> <number>`. The symptom is `131030 Recipient phone number
  not in allowed list` on every send while read and typing still work.
- Sends are at most once. `send_started_at` is committed before the Graph call; a row that dies after that
  (timeout, 5xx, killed worker) ends as `unknown` and is never sent again. Only an HTTP 4xx answer, which
  proves nothing was sent, goes back to `pending` (retryable codes) or `failed` (permanent codes).
- **Message flow (slices 3, 4, agent B and B2).** A text or photo message from an allowed sender runs the read receipt plus
  typing and the agent together (a photo's download runs beside them; a voice note, `audio`, is downloaded and transcribed beside them,
  or answered with a request for text when `OPENROUTER_API_KEY` is not set; any other kind gets a short reply, and neither calls the model). Deadlines count from `received_at` and are processor options (`interimMs` 10 s,
  `deadlineMs` 30 s). The commit point is one transaction (`store.commit`): the actions' effects, the movements (unique on
  `(inbound_message_id, position)`, counted across the whole message), the stored `reply_text` and the audit.
  Before it, a failed agent run (a model error, no valid action in 3 turns) or the deadline ends the message
  `failed` with one failure notice (`failure_sent_at`, committed before the send) and a late model result
  writes nothing. After it, the stored reply is sent even if late,
  and the sweep sends it without calling the model. The interim note (`interim_sent_at`) and the failure notice are committed before they are sent and never repeated. There is no done mark (a ✅ reaction was removed 2026-11-21). A tool call with an unstorable
  value (bad amount, date or description) is never repaired: the loop answers it with the reason and the
  model gets another turn; a model that cannot fix it within 3 turns fails the message.
- Optional `HELP_CONTACT` adds a human contact line to the help reply; unset adds nothing.
- **Photos (agent B2).** An `image` webhook message keeps its media id and caption in `inbound_message`
  (`payload`, `body`); the bytes are never stored. `graph.fetchImage` looks the id up, checks the declared size
  and type, downloads from a Meta https host only (the token goes nowhere else), reads at most 5 MB and takes
  the type from the bytes (JPEG, PNG or WebP), all through the keep-alive client. The agent gets an image block
  before its context, with the caption in `<mensaje>`. A photo that cannot be read (too big, another type, a
  failed download) is answered with its own text (`REPLY_IMAGE`) through the commit point as a code `notice`,
  with no model call. The next message's conversation window shows it as `[foto] caption`.
- **Voice notes (agent voice).** An `audio` webhook message keeps its media id in `inbound_message.payload` and, once
  it is understood, what was heard in `body`; the audio is never stored. `graph.fetchAudio` is the photo's download
  (Meta https hosts only, no redirects, one 8 s budget, a streaming cap) with a 3 MB cap and the type read from the
  bytes: Ogg (the voice note, Opus), MP4/M4A or MP3; raw AAC and AMR are refused, as the service refuses them.
  `transcribe.ts` posts the file to OpenRouter's `/audio/transcriptions` (`openai/whisper-large-v3`, `language=es`,
  `temperature=0`, `verbose_json`, a vocabulary prompt) with `provider={"order":["groq"],"allow_fallbacks":false}`:
  unpinned it routes to DeepInfra, which mishears names ("IPEF" for YPF). The call has its own 10 s budget inside the
  message's 30 s deadline. `judgeTranscript` is the confidence gate on the segments (mean avg_logprob, worst segment,
  compression_ratio, no_speech_prob, empty or punctuation-only text): a refused note is answered with a code notice
  ("No te entendí el audio, ¿me lo escribís?") and no model call. Every other failure (download, service, budget)
  is a code notice too ("No pude procesar el audio, ¿me lo escribís?"), with the cause in the log and the audit; only
  the 30 s deadline is the failure path. What was heard becomes the message for everything after it (the model's
  context says it is a transcript, the numbers check counts it as the person's words), a reply with no
  record of a change (an answer, a summary, a question, the model's own words, or a change that did not apply)
  starts with `🎙️ "<transcript>"`, cut at 80 characters and rendered by code; when something was logged, corrected or
  deleted the record already shows what was understood and the line is left out. The next message's window shows
  `[audio] <transcript>`. A bare answer to
  our question ("el segundo") by voice goes to the model, never to `answerAction`: code does not delete or correct
  on what a speech model thought it heard. A reply is held under 4,000 characters (`fitReply`: WhatsApp refuses 4,096
  after the commit).
- **A question narrowed to one movement.** After "¿Qué querés cambiar? YPF $3.000 · 11:42" (one option, nothing
  pending), a typed "ese", "sí" or "ese mismo" is answered by code with the same question, never other options. A message
  with a change ("a ese ponele 3500") goes to the model, whose context says the question has one option and what to
  do; and an `ask_user` over that one id with `changes` is run by the guard as `correct_movement` (the person saw that
  movement: asking again would loop). An `ask_user` with `after_answer: correct` and no `changes` is taken as `none`
  when the message holds no amount (digits or number words), and refused, with the reason saying what to send, when it does.
- **Shutdown.** On SIGTERM `processor.stop()` aborts agent runs that have not reached the commit point and settles
  those rows to `pending`, so the next process's startup sweep answers them inside their deadline. The deadline
  is one `AbortSignal` checked right before the commit; a deadline that fires mid-commit loses (committed
  means the reply goes out). `today` comes from the message's own time (`meta_ts`), not the clock.
- **The agent (slice B; `docs/agent-spec.md`, Slice B notes).** `src/agent/loop.ts` is a manual loop on
  `client.messages.create` (Haiku 5.5, effort low, thinking off, tools that are **not** strict (strict decoding cost 0.2-0.3 s a call; code
  parses and checks every input), a frozen system prompt and tool list under one cache breakpoint with the
  **1-hour TTL** (`CACHE_TTL`; the startup warm-up writes the same one); `usage.cache_read_input_tokens` is logged
  at every commit). When the list holds fewer than 10 movements it is the person's whole history, and the context says
  so: the model does not spend a turn on `find_movements`. The volatile
  context comes after the breakpoint: the Argentine date and time, a 14-day calendar, the 10 newest live
  movements with position, **id** and logged time, the conversation window (the sender's committed turns of the
  last 30 minutes, at most 6, from `inbound_message.body` and `reply_text`) and, within 10 minutes, the
  question Warren just asked with the id behind each option. Tools:
  - `find_movements` (read): the sender's whole history, by text, dates, category, payment, amount; at most 20
    rows with ids. Its results go back in one user message (parallel calls included).
  - Terminal, run by code at the commit point in the order given, in one transaction, one combined reply:
    `log_movements`, `correct_movement`, `delete_movement`, `summarize` (today's periods and filters, including `description`: the words of a description, so a count such as "cuántos cafés" is code's line),
    `ask_user` (a short phrase plus the movements to offer, newest first, numbered 1..k by code; it stores
    `asked_numbers`, `asked_ids` and `pending`, what choosing an option will do; it has no `text`: code asks once), `reply({text})` (the model's
    own words, for what is not a change: a question about what Warren did, thanks, something off topic) and
    `help` (the one canned text, for "ayuda" and greetings).
  - **Undo (slice C).** `undo_last` (input: only `text`) takes back the sender's last write batch, the whole of what one earlier message
    logged, corrected or deleted. It goes alone in its turn (sent with another action it is refused and the model sends again).
    The batch, the guard and the reversal are code's (`src/undo.ts`); the model sends no id. A typed bare "deshacer" / "volvé atrás" /
    "anulá lo que hiciste" (`undoRequest`) is answered by code with no model call; by voice, and every other phrase ("no, eso no"), it
    goes to the model. "deshacé el café" names one movement: that is a delete, not an undo. The record is `↩︎ Deshice: Súper $5.000 · Panadería
    $3.000` (a log) or a bulleted list when a correction or delete is undone. See `docs/agent-spec.md`, Agent slice C notes.
  - **The model's own words (B2).** Every write tool and `summarize` carry a `text` (a nullable, always present). `text` is null unless it adds
    something; one that only repeats the person's message, or only restates the lines code rendered (every word is filler or already in a line: "Corregí el café de las 11:11" beside "✓ Corregido: Café …· 11:11"), is dropped (not an error; a `reply` is never dropped for this). Code sends the record of what changed (and the totals, and the question) first, then the texts, in
    order. A text goes out only if `checkSay` passes: at most 280 characters, no `✓`, no number in digits or
    in words that was not given by code, no figure made of given pieces ("2 lucas", "12 500", a minus, a
    percent) and no claim of a change ("borré", "corregí", "anoté", "listo") that this message's own outcomes
    do not show (`composeReply` takes them as structured steps); only a `reply` may lean on the replies earlier in
    the conversation, and so can be fooled by an old line about another movement. A number is given if it is in the person's message, the movement list
    (ids left out), the conversation window, the pending question's option numbers, this message's
    `find_movements` results or the lines code rendered for this message; amounts, times and days are compared by
    value (`12.000` = `12000`, `9:12` = `09:12`, `2026-11-03` = `03/11`). A failing text is dropped (the audit
    entry says `text: dropped` and why; a `reply` that is dropped sends `REPLY_SAY_FALLBACK`), as is a text beside
    an action that did not apply. A description or payment with 4 or more digits in a row is refused like any
    other bad value.
  - **A refused text gets a repair turn (B2).** Before it accepts a turn's actions the loop runs the numbers
    check on their texts, with what the model was shown (not yet the lines code renders; the amounts and dates
    the actions carry count). If one fails (and it is not an echo), none of the turn's actions runs (audit
    `repair`): every call is answered with the reason, and the model sends them again inside the cap. On the
    last turn it goes on and the commit point drops the text. `REPLY_SAY_FALLBACK` is only for that case.
  - **A turn that searches and writes does not end the loop (B2).** Code runs the reads, holds the writes
    (audit status `held`) and answers them with "your changes were not run; send every change again". The model
    then sends every change with the results in view, inside the same cap of 3 turns. A plain log or summary is
    still one model call.
  - Guards, in code: an id must have been shown to the model in this message (list, find result or pending
    question) and, at the commit, belong to the sender and be live (`lockLive`, `FOR UPDATE`), else that action's
    line is "ya fue corregido o borrado" and the others still run; amounts are decimal strings, dates real and
    not in the future (a refusal is answered to the model, not repaired); at most 10 movements per message; an
    empty correction is refused; an `ask_user` question longer than a short phrase or with a digit or `$` in it
    is replaced; the model never computes a total; the cap is 3 model turns and a text-only answer costs one;
    the deadline signal is on every call; a failure or the deadline writes nothing.
  - **An expired question is marked (B2).** A question older than 10 minutes, or one that a newer message
    replaced, still shows in the conversation window, now with "pregunta vencida" under it, so that "borrá el 2"
    reads as a position of the list and not as its option 2.
  - **One question, then one about the movement picked (B2).** A question with no action behind it
    (`after_answer` none, several options) answered with a number is not sent to the model: `answerAction`
    asks "¿Qué querés cambiar?" about that one movement (without listing the others) and keeps it as the pending
    option, so the next message is read against it.
  - **A bare answer to our question is code's job.** If the previous message got an `ask_user` with a pending
    action, at most 10 minutes ago, and the new message is only an answer (`answerNumber`: "2", "el primero",
    "sí" after one option), `answerAction` runs the pending correction or delete on the id that option offered
    and no model is called. Anything with more in it ("el 2 fue 4500") goes to the model, which sees the options.
  - A correction is a new row (`superseded_by`), a delete stamps `deleted_at`/`deleted_by`; every correction or
    delete reply shows before and after, and the logged time (and the day, if not today) when the movement is
    not the newest.
  - Stored on the message: `parsed` what the model asked for (null when no model ran), `command` what ran (both
    lists of `{tool, input}`), `action` (log, correct, delete, summarize, ask, reply, undo, multi), `tool_calls` the
    audit (every call with turn, input, outcome, ms), `model_turns`, `model_ms`.
- **Summaries (slice D; `docs/agent-spec.md`, Agent slice D notes).** `summarize` is `{range, group_by, compare_to, other?, direction, category,
  payment, description, text}`. `range` is always `{period, month, year, from, to}`: a named period (`today`, `yesterday`, `this_week`,
  `last_week`, `weekend`, `last_weekend`, `this_month`, `last_month`, `this_year`, `last_year`), or `month` (a month number, the year
  optional), `year`, or `dates` (`from`/`to` as `yyyy-mm-dd`, `mm-dd` or `dd`, the way a person says them). A field a period does not use is
  `0` or `""`; a stray one is refused. `src/range.ts` resolves it in Argentine days from the message's own time: weeks are Monday to Sunday,
  "el finde" is Saturday and Sunday, a period that is not over ends today ("en lo que va del año"), "el 5" is this month's unless that is still
  to come, "octubre" is the latest October that has started, and "5 de octubre" the latest such day not in the future. A range that has not
  started, a reversed one, or one over 731 days (two years) is refused with the reason the model reads and `checkCall` answers it like any
  other refusal. `group_by` is `none`, `category`, `payment`, `day`, `week` or `month`; `compare_to` is `none`, `previous` (the same-length
  range before; the previous calendar month for a month, week for a week, year for a year, **cut to the same stretch while the period is
  still running**: 1–21 November against 1–21 October, clamped to a shorter month, the year so far against the same days of last year;
  a custom range that is a whole month counts as one) or `range` (with `other`, a second range). A comparison cannot be grouped by time. Totals and groups are `sum()`/`count()` in SQL over
  live movements, by direction and currency, never converted; a payment group ignores case and accents; a comparison is two SQL results, and
  `summary.ts` computes the difference and the percentage (tenths of a percent, half away from zero; no percentage when there is nothing
  before). `render-summary.ts` names the range in words ("Octubre (1–31)", "Semana pasada (9–15 nov)"), lists at most 8 groups (then
  "• … y N más") or at most 31 days, weeks or months (the newest, then "• … y N anteriores"), and goes through `fitReply`.
- **Weeks, periods and queries.** Weeks are Monday to Sunday and whole, so `this_week` can end after today; months
  and years are calendar ones; all ranges are Argentine days (`resolveRange`, from the message's own time), and a period still in progress
  ends today. The payment filter is
  accent- and case-insensitive contains (`translate`, no `unaccent` extension). `supermercado` reads as "Súper".
  Changing `tools.ts`, `schema.ts` or `prompt.ts` means rerunning `pnpm eval` and `pnpm eval:scenarios` (dev
  first). The server sends one tiny warm-up request at startup, which writes the prompt cache. Each sent reply stores
  its stages in `inbound_message.timings` (`src/timings.ts`; a failed message keeps the ones it reached); a speed change is judged with `pnpm latency` on real
  traffic and `pnpm eval:scenarios` (per-turn p50/p95, second-turn rate and causes, output tokens per action).
- **Memory (slice F; `docs/agent-spec.md`, Agent slice F notes).** What a person tells Warren about their money and habits is kept in `fact`
  (account, `kind` alias | category | note, a normalized `key`, `value`, the source message, `superseded_by`, `forgotten_by`, `restores`), one live
  fact per account, kind and key (a partial unique index). Tools, all terminal and rendered by code (`🧠 Me acuerdo: la visa = Galicia`, `🧠 Me olvidé: ...`):
  - `remember_fact({kind, key, value, text})`: only what the person states. `checkFact` (`src/agent/memory.ts`) refuses a secret (card or CBU/CVU number,
    password or PIN, DNI: the person is told "No guardo ...", by a code `notice`, with no second model turn), a key that is not words of the person's own message,
    a number they did not write, a key over 40 characters or 4 words, a value over 100, a category value outside the list. The account holds at most 100 live facts (`full`).
  - `forget_fact({id, key, text})`: an id must be one the model was shown (the 30 newest live facts, in the context as "Hechos"), or a key, looked up among the sender's own.
    `forget_all_facts` only asks "¿Seguro...? Respondé sí." and stores `pending: {action: 'forget_all'}`; a bare "sí" next (`answerAction`, no model call) runs
    `forget_all_confirmed`, which no model call can produce. `list_facts` is code listing every live fact.
  - The facts are in the volatile context, never in the cached prefix; the model reads them to resolve aliases and categories; the ledger stays the truth, and a fact never logs, corrects or deletes by itself.
  - Undo (slice C) reaches facts: a batch is any message that stored or forgot a fact too, and `undo-facts.ts` reverses it append-only, refusing the whole undo when a fact is no longer as the batch left it.
