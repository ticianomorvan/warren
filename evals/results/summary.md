# Eval summary

Last run 2026-11-20, prompt as committed. Full results go to `evals/results/*.json` (gitignored).
Gate: at least 97% fully correct and 0 silently wrong amounts.

| Model                                         | Split    | Fully correct | Silent | p50 / p95 (ms, from a Mac in Argentina) | Mean in / out / cache read tokens | Cost      |
| --------------------------------------------- | -------- | ------------- | ------ | --------------------------------------- | --------------------------------- | --------- |
| claude-haiku-5-5 (effort low, thinking off)   | test, 25 | 25/25         | 0      | 988 / 1,174                             | 402 / 72 / 7,770                  | US$0.0039 |
| claude-sonnet-5-5 (effort low, between_tools) | test, 25 | 25/25         | 0      | 2,125 / 2,506                           | 402 / 72 / 7,770                  | US$0.0576 |
| claude-haiku-5-5                              | dev, 106 | 106/106       | 0      | 984 / 1,162                             | 401 / 79 / 7,770                  | US$0.0166 |
| claude-sonnet-5-5                             | dev, 106 | 106/106       | 0      | 2,072 / 2,498                           | 401 / 79 / 7,770                  | US$0.2506 |

Rerun under the stricter grader (target of a correction or delete and the query direction,
category and payment are hard fields; a merged movement counted as silent): claude-haiku-5-5,
split all, 131 cases: **131/131 fully correct, 0 silent wrong amounts**, p50 / p95 1,034 / 1,263
ms, mean in / out / cache read / cache write tokens 401 / 77 / 7,573 / 58 (the cache had expired
before this run, so the first request wrote it), US$0.0212. Test-split detail is not stored. The
Sonnet rows above were measured before the grader was tightened and were not rerun.

Soft fields (description, category, payment, target, query fields) were 99 to 100% on dev and
100% on test for both models.

Chosen: claude-haiku-5-5.
