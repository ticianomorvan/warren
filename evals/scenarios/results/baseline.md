# Scenario eval baseline (slice A)

Run 2026-11-21 on `main` plus the runner: the slice 4 pipeline as it ships, claude-haiku-5-5 with
the existing prompt and rules, `pnpm eval:scenarios --split all --budget 0.30`. 94 scenarios, 111
model calls, one run. The first run, taken before one scenario expectation was fixed, gave 79/94;
runs differ by a scenario or two, so read the numbers to about ±2 scenarios.

Gate (`docs/agent-spec.md`): at least 95% of scenarios fully right, 0 silent wrong changes, 0 invented
numbers. **The baseline fails it**, as expected: it is the number slice B has to beat.

## Numbers

|                       | Dev (75)   | Test (19, counts only) | All (94)   |
| --------------------- | ---------- | ---------------------- | ---------- |
| Fully right           | 65 (86.7%) | 15                     | 80 (85.1%) |
| Silent wrong changes  | 3          | 2                      | 5          |
| Unnecessary questions | 1          | 0                      | 1          |
| Invented numbers      | 0          | 0                      | 0          |

- Per turn (post to stored reply, model included; the fake Graph and PGlite add a few ms):
  p50 1,269 ms, p95 2,032 ms. The model call alone: p50 1,254 ms, p95 2,019 ms. By action, p50 /
  p95: log 1,250 / 2,130 ms, correct 1,447 / 2,015 ms, delete 1,276 / 2,032 ms, query 1,168 /
  2,118 ms, question 1,172 / 2,241 ms. Measured from a Mac in Argentina over the real API.
- Cost: US$0.0221 for the run, US$0.00020 per turn (111 turns).
- Pass rate per tag, all 94 (a scenario counts in each of its tags): logging 26/28, correction 27/37,
  deletion 15/21, answer 8/10, query 13/13, multi-action 0/7, older-item 0/4, typo 8/8,
  time-reference 16/19, other 2/2.

## Dev failures, one line each

A scenario stops at its first wrong turn. "Silent" means a wrong write under a reply that starts with
`✓`.

- s038 `el 1 luca fue 1500`: **silent.** "el 1" read as list number 1 (the helado), not the 1,000
  peso kiosco. Helado 2,500 became 1,500 under "✓ Corregido".
- s061 `cambiame lo del almuerzo a 5000`: nothing is named "almuerzo"; the model returned `help`
  instead of a correction, so no question was asked.
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

## Failure patterns

1. **Two actions in one message** (multi-action 0/7 overall): the pipeline takes one command per
   message. It drops the second action under a normal-looking reply (s069, s071, s073), or answers
   `help` (s068, s070), or asks for "una cosa por mensaje". Never a wrong row, but the person's
   second request is lost.
2. **Anything older than the newest 10 movements** (older-item 0/4): the model cannot see it, so it
   logs a duplicate (s075), asks a useless question (s076) or corrects a similar newer row (s077).
   Two of the three are silent wrong changes.
3. **A number that is an amount, read as a list position** (s038): the 1,000-peso kiosco was
   "el 1 luca". The other amount-after-article, date and "del 3" scenarios pass, so this is the
   fragile edge of the position rules.
4. **An unmatched description gets `help`, not a question** (s061): a correction naming something
   not in the list is classified as help.

What passes: all 13 queries, all 8 typo scenarios, "el café de las 10", "el de las 12 menos 5", "uno de
los cafés" (asks), "el último café", "el otro café", "el café del 3", and the answer scenarios
("2", "la segunda", "dale", a stale answer).

## Test split (counts only)

15 of 19 fully right, 2 silent wrong changes, 0 unnecessary questions. No ids, texts or reasons are
kept for the test split.

## Sources and what is not in here

- **The production transcripts (`inbound_message` rows 24–42) were not read.** The sandbox denied the
  read-only SELECT on production Postgres, so no row of it is in the scenarios. The `transcript`
  scenarios (s027, s028, s029, s035, s059, s067) are rebuilt from the three phrasings the brief
  quotes ("el café de las 10 fue 2500", "uno de los cafés estaba mal", "el de las 12 menos 5 fue de
  2000"), the 11:54 and 10:10 café times it gives, and the live bug in `docs/spec.md` ("el 2 fue
  4500"). Replace or add to them from the real rows when someone with access can read them.
- Scenarios and expectations were written before the baseline ran and not tuned to it, except s013
  (expected a payment of "transferencia" for "me transfirió"): an expectation, not a model, fault.
- The runs were not repeated to measure variance beyond the two noted above.
