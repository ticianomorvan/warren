# Warren model bench: smoke2

Started 2026-11-21T14:14:15.052Z. 5 cases per candidate, concurrency 2, candidates rotated in chunks of 5. Spend this run US$0.0062; total ever spent on the bench US$0.0149 (cap 3).

| Candidate     | Dev full | Test full | All full     | Silent wrong $ | HTTP err | Schema fail | p50 ms | p95 ms | p99 ms | US$/msg  | Reasoning tokens (cases) | Cache hit                     | Gate |
| ------------- | -------- | --------- | ------------ | -------------- | -------- | ----------- | ------ | ------ | ------ | -------- | ------------------------ | ----------------------------- | ---- |
| gpt6-luna     | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 2222   | 2396   | 2396   | 0.000212 | 0 (0)                    | 80.0% (mean 3578 of 4742 tok) | PASS |
| mistral-small | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 1046   | 1180   | 1180   | 0.000252 | 0 (0)                    | 80.0% (mean 3550 of 4554 tok) | PASS |
| gpt-oss-groq  | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 1033   | 1139   | 1139   | 0.000770 | 215 (5)                  | 20.0% (mean 768 of 4954 tok)  | PASS |

## Dev failures (held-out test failures are never listed)

### gpt6-luna (0)

### mistral-small (0)

### gpt-oss-groq (0)
