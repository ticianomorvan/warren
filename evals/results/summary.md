# Eval summary

Last run 2026-11-20, prompt as committed. Full results go to `evals/results/*.json` (gitignored).
Gate: at least 97% fully correct, 0 silently wrong amounts and 0 silently wrong targets (a confident wrong
`target_index` that `resolveTarget` would still apply; see Slice 4 notes in `docs/spec.md`).

| Model                                         | Split    | Fully correct | Silent | p50 / p95 (ms, from a Mac in Argentina) | Mean in / out / cache read tokens | Cost      |
| --------------------------------------------- | -------- | ------------- | ------ | --------------------------------------- | --------------------------------- | --------- |
| claude-haiku-5-5 (effort low, thinking off)   | test, 25 | 25/25         | 0      | 988 / 1,174                             | 402 / 72 / 7,770                  | US$0.0039 |
| claude-sonnet-5-5 (effort low, between_tools) | test, 25 | 25/25         | 0      | 2,125 / 2,506                           | 402 / 72 / 7,770                  | US$0.0576 |
| claude-haiku-5-5                              | dev, 106 | 106/106       | 0      | 984 / 1,162                             | 401 / 79 / 7,770                  | US$0.0166 |
| claude-sonnet-5-5                             | dev, 106 | 106/106       | 0      | 2,072 / 2,498                           | 401 / 79 / 7,770                  | US$0.2506 |

Rerun after the second review (prompt examples no longer match any eval case, stricter grader:
targets and query fields are hard, stopwords no longer match, amounts compare as decimals, a
merged movement counts as silent). claude-haiku-5-5, split all, 131 cases: **131/131 fully
correct, 0 silent wrong amounts**, which is dev 106/106 and test 25/25. p50 / p95 967 / 1,128 ms,
mean in / out / cache read / cache write tokens 401 / 77 / 7,581 / 58 (the prompt changed, so the
first request wrote the cache), US$0.0212. Test-split detail is not stored. The Sonnet rows above
were measured before these changes and were not rerun.

Soft fields (description, category, payment, target, query fields) were 99 to 100% on dev and
100% on test for both models.

Chosen: claude-haiku-5-5.

Slice 4 (2026-11-21): claude-haiku-5-5, split all, 139 cases: **138/139 fully correct, 0 silent wrong amounts,
0 silent wrong targets**, p50 / p95 1,466 / 2,090 ms, US$0.0251. Miss: c132 (ambiguous target; the model picks
number 1, code asks).

Slice 4, after live use (2026-11-21): claude-haiku-5-5, split all, 146 cases: **146/146 fully correct, 0 silent wrong
amounts, 0 silent wrong targets**, p50 / p95 1,159 / 1,706 ms, US$0.0279. Ambiguous targets now expect the newest
match; 7 cases carry a previous exchange.

Slice 4 review fixes (2026-11-21): claude-haiku-5-5, split all, 154 cases: **151/154 fully correct, 0 silent wrong
amounts, 0 silent wrong targets**, p50 / p95 1,216 / 1,807 ms, US$0.0311.
