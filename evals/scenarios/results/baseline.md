# Scenario eval baseline (slice A)

Run 2026-11-21 on branch `agent-a-scenarios`: the slice 4 pipeline as it ships, claude-haiku-5-5
with the existing prompt and rules, `pnpm eval:scenarios --split all --budget 0.08`. 98 scenarios,
115 model calls, one run. This replaces the first baseline (94 scenarios, 80/94), taken before the
`transcript` scenarios were rebuilt from the real conversation (see Sources). Runs differ by a
scenario or two (s061, for one, failed at turn 1 in the first run and at turn 2 in this one), so read
the numbers to about ±2 scenarios.

> Note (2026-11-21, after this run): s059 was changed to expect acting on the newest café, per the
> act-when-confident decision (agent-spec Decisions 2). The pipeline already does that, so the baseline
> is about one scenario better than the table below: roughly 83 fully right and 5 silent.

Gate (`docs/agent-spec.md`): at least 95% of scenarios fully right, 0 silent wrong changes, 0 invented
numbers. **The baseline fails it**, as expected: it is the number slice B has to beat.

## Numbers

|                       | Dev (77)   | Test (21, counts only) | All (98)   |
| --------------------- | ---------- | ---------------------- | ---------- |
| Fully right           | 65 (84.4%) | 17                     | 82 (83.7%) |
| Silent wrong changes  | 5          | 1                      | 6          |
| Unnecessary questions | 1          | 0                      | 1          |
| Invented numbers      | 0          | 0                      | 0          |

- Per turn (post to stored reply, model included; the fake Graph and PGlite add a few ms):
  p50 1,398 ms, p95 2,123 ms. The model call alone: p50 1,385 ms, p95 2,108 ms. By action, p50 /
  p95: log 1,447 / 1,689 ms, correct 1,482 / 2,020 ms, delete 1,358 / 2,146 ms, query 1,337 /
  2,270 ms, question 1,211 / 2,190 ms. Measured from a Mac in Argentina over the real API.
- Cost: US$0.0245 for the run, US$0.00021 per turn (115 turns).
- Pass rate per tag, all 98 (a scenario counts in each of its tags): logging 27/29, correction 29/41,
  deletion 15/22, answer 7/10, query 13/13, multi-action 0/8, older-item 0/4, typo 8/8,
  time-reference 16/19, other 2/2.

## Dev failures, one line each

A scenario stops at its first wrong turn. "Silent" means a wrong write under a reply that starts with
`✓`.

- s038 `el 1 luca fue 1500`: **silent.** "el 1" read as list number 1 (the helado), not the 1,000
  peso kiosco. Helado 2,500 became 1,500 under "✓ Corregido".
- s059 (transcript) `el café fue 2500`, two cafés (10:10, 11:11), no cue: **silent**, by the
  scenario's reading (it expects `¿Cuál?`). The pipeline corrected the newest café, "antes $3.500".
  The reading is debatable: see the note on s059 below. The bare "2" turn was not reached.
- s061 `la segunda` (turn 2): **silent.** After a `¿Cuál?` the answer deleted the café ("✓ Borré")
  instead of correcting it to 5000. It passed in the first run: the model is not stable here.
- s068 `borrá el 2 y cambiá el 1 a 4000`: two actions; the model returned `help`, nothing was done.
- s069 `el café de las 10 fue 2500 y el súper 13.000`: only the café was corrected; the second action
  was dropped and the reply says nothing about it.
- s070 `borrá la nafta y el taxi`: two actions; `help`, nothing done.
- s071 `el último café fue 3000 y anotá subte 1200`: only the subte was logged; the correction was
  dropped.
- s073 `borrá el café de las 10 y el de las 12 menos 5`: only the first café was deleted.
- s075 `el alquiler fue 250000` (alquiler is the 12th newest): **silent.** Not in the 10-item list, so
  the message was read as a new log: a phantom "Alquiler $250.000" row, the real one untouched.
- s076 `borrá lo del veterinario` (13th newest): nothing in the list matches, so it asks `¿Cuál?`
  over the three newest items instead of finding the movement (the one unnecessary question).
- s077 `la nafta del 4/11 fue 23000` (the 4/11 nafta is older than the list): **silent.** The newer
  nafta of 19/11 was corrected, "antes $20.000" shown.
- s096 (transcript) `el dos bórralo, cambiame el primero`: the pipeline answers "Por ahora hago una
  cosa por mensaje"; the expected outcome is café 11:11 deleted and a question about the súper.

## Failure patterns

1. **Two actions in one message** (multi-action 0/8 overall): the pipeline takes one command per
   message. It drops the second action under a normal-looking reply (s069, s071, s073), or answers
   `help` (s068, s070), or asks for "una cosa por mensaje" (s096). Never a wrong row, but the
   person's second request is lost.
2. **Anything older than the newest 10 movements** (older-item 0/4): the model cannot see it, so it
   logs a duplicate (s075), asks a useless question (s076) or corrects a similar newer row (s077).
   Two of the three are silent wrong changes.
3. **A number that is an amount, read as a list position** (s038): the 1,000-peso kiosco was
   "el 1 luca". The other amount-after-article, date and "del 3" scenarios pass, so this is the
   fragile edge of the position rules.
4. **An answer after a question is not stable** (s061): "la segunda" was a delete this run.
5. **Acting versus asking when two rows fit** (s059): see below.

What passes of the replayed conversation: "uh perdón, el café fueron 4500" (s095, the newest café),
"el 2 fue 4500" (s035), "el café de las 10" with a newer café around (s027), "me equivoque en uno de
los cafes" (s029, asks), "uh, era 2700" right after logging (s097), "el último café" (s098). Also all
13 queries, all 8 typo scenarios and "uno de los cafés" in the earlier synthetic set.

## Test split (counts only)

17 of 21 fully right, 1 silent wrong change, 0 unnecessary questions. No ids, texts or reasons are
kept for the test split. It holds two replayed sequences (s028, s067: the 12:07 messages "uno de los
cafés estaba mal" and "el de las 12 menos 5 fie de 2000").

## Sources and what is not in here

- **The `transcript` scenarios are replays of the real conversation of 2026-11-21** (the read-only
  production export, messages 17–42, Argentine times). Each one seeds the live ledger as it stood
  just before the sequence, with the real logged times, then sends the real message texts with their
  real "now". Expectations are the **intended** outcome of `docs/agent-spec.md`, not what production
  did:

  | Scenario | Real message(s)                                                              | Intended outcome                                                       |
  | -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
  | s095     | 26 "uh perdón, el café fueron 4500"                                          | fix the newest café (11:11), "antes $3.500"                            |
  | s096     | 27 "el dos bórralo, cambiame el primero"                                     | delete list number 2; ask what to change on number 1 (no change given) |
  | s035     | 28 "el 2 fue 4500"                                                           | list number 2 (café 11:11) to 4500                                     |
  | s059     | 29-30 "el café fue 2500", then "2"                                           | ask (two cafés, no cue), then number 2 gets the 2500                   |
  | s097     | 34-35 "cafe 3000", "uh, era 2700"                                            | log, then fix that café                                                |
  | s029     | 36 "me equivoque en uno de los cafes"                                        | ask, listing the cafés                                                 |
  | s027     | 37 "el café de las 10 fueron 2500"                                           | the café logged at 10:10                                               |
  | s098     | 39 "el último café fueron 2900"                                              | the café logged last                                                   |
  | s067     | 41-42 "uno de los cafés estaba mal", then "el de las 12 menos 5 fie de 2000" | ask, then the café logged at 11:54                                     |
  | s028     | 42 alone                                                                     | the café logged at 11:54                                               |

- **Readings the expectations rest on** (change them if the product owner reads the spec otherwise):
  - s096: "el dos" is list number 2 (newest first, as the list the model sees); "el primero" is list
    number 1 (the súper). With no change given for it, the reply must ask what to change, and the
    súper must stay as it was. The delete goes through, so the turn has an op and the reply must
    contain both `Borré` and a question about the change.
  - s095 versus s059: "uh perdón" marks a slip just made, so the newest matching café is fixed. The
    s059 sentence, "el café fue 2500", has no such cue and two cafés fit, so it asks. A reader who
    would act on the newest café there too makes the pipeline's current answer right and s059 turn 1
    wrong. The bare "2" is the number printed beside an option (2 and 9 in the real reply), not its
    position in the question.
  - Seeds hold live rows only, in logged-time order, so a corrected row (which production lists
    first because it is new again) sits at its logged time. Nothing replayed depends on that.
  - Prior bot replies are not seeded: a sequence starts from the ledger, and a question the bot
    asked is part of the scenario only where it is a turn (s059, s067).
- Scenarios and expectations were written before the baseline ran and not tuned to it, except s013
  (expected a payment of "transferencia" for "me transfirió"): an expectation, not a model, fault.
- The runs were not repeated to measure variance beyond the ones noted above.
