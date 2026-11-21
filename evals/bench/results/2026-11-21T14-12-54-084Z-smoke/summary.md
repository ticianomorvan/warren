# Warren model bench: smoke

Started 2026-11-21T14:12:54.084Z. 5 cases per candidate, concurrency 2, candidates rotated in chunks of 5. Spend this run US$0.0088; total ever spent on the bench US$0.0088 (cap 3).

| Candidate         | Dev full | Test full | All full     | Silent wrong $ | HTTP err | Schema fail | p50 ms | p95 ms | p99 ms | US$/msg  | Reasoning tokens (cases) | Cache hit                     | Gate |
| ----------------- | -------- | --------- | ------------ | -------------- | -------- | ----------- | ------ | ------ | ------ | -------- | ------------------------ | ----------------------------- | ---- |
| haiku-direct      | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 1694   | 1951   | 1951   | 0.000328 | 0 (0)                    | 80.0% (mean 6111 of 8023 tok) | PASS |
| haiku-vertex      | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 2451   | 3578   | 3578   | 0.000694 | 0 (0)                    | 40.0% (mean 3130 of 8210 tok) | PASS |
| haiku-bedrock     | 0/4      | 0/1       | 0/5 (0.0%)   | 0              | 5        | 0           | 0      | 0      | 0      | 0.000000 | 0 (0)                    | 0.0% (mean 0 of 0 tok)        | FAIL |
| gpt6-luna         | 0/4      | 0/1       | 0/5 (0.0%)   | 0              | 5        | 0           | 0      | 0      | 0      | 0.000000 | 0 (0)                    | 0.0% (mean 0 of 0 tok)        | FAIL |
| mistral-small     | 0/4      | 0/1       | 0/5 (0.0%)   | 0              | 5        | 0           | 0      | 0      | 0      | 0.000000 | 0 (0)                    | 0.0% (mean 0 of 0 tok)        | FAIL |
| gemini-flash-lite | 4/4      | 1/1       | 5/5 (100.0%) | 0              | 0        | 0           | 1756   | 1848   | 1848   | 0.000729 | 0 (0)                    | 80.0% (mean 2367 of 4477 tok) | PASS |
| gpt-oss-groq      | 0/4      | 0/1       | 0/5 (0.0%)   | 0              | 5        | 0           | 0      | 0      | 0      | 0.000000 | 0 (0)                    | 0.0% (mean 0 of 0 tok)        | FAIL |

## Dev failures (held-out test failures are never listed)

### haiku-direct (0)

### haiku-vertex (0)

### haiku-bedrock (4)

- c001 "cafe 3500": http: http 404: No endpoints found for anthropic/claude-haiku-5.5. Every candidate endpoint was removed during routing: Filter by Regional Surcharge removed google-vertex/europe, google-vertex/us, azure/us, amazon-bedrock/us-east-1, amazon-bedrock/eu-west-1; Filter by Parameters removed claude-on-aws, amazon-bedroc
- c002 "Pague 12.000 de luz": http: http 404: No endpoints found for anthropic/claude-haiku-5.5. Every candidate endpoint was removed during routing: Filter by Regional Surcharge removed google-vertex/europe, google-vertex/us, azure/us, amazon-bedrock/us-east-1, amazon-bedrock/eu-west-1; Filter by Parameters removed claude-on-aws, amazon-bedroc
- c003 "gasté 8500 en la farmacai": http: http 404: No endpoints found for anthropic/claude-haiku-5.5. Every candidate endpoint was removed during routing: Filter by Regional Surcharge removed google-vertex/europe, google-vertex/us, azure/us, amazon-bedrock/us-east-1, amazon-bedrock/eu-west-1; Filter by Parameters removed claude-on-aws, amazon-bedroc
- c004 "subte 1200": http: http 404: No endpoints found for anthropic/claude-haiku-5.5. Every candidate endpoint was removed during routing: Filter by Regional Surcharge removed google-vertex/europe, google-vertex/us, azure/us, amazon-bedrock/us-east-1, amazon-bedrock/eu-west-1; Filter by Parameters removed claude-on-aws, amazon-bedroc

### gpt6-luna (4)

- c001 "cafe 3500": http: http 400: Provider returned error
- c002 "Pague 12.000 de luz": http: http 400: Provider returned error
- c003 "gasté 8500 en la farmacai": http: http 400: Provider returned error
- c004 "subte 1200": http: http 400: Provider returned error

### mistral-small (4)

- c001 "cafe 3500": http: http 400: Provider returned error
- c002 "Pague 12.000 de luz": http: http 400: Provider returned error
- c003 "gasté 8500 en la farmacai": http: http 400: Provider returned error
- c004 "subte 1200": http: http 400: Provider returned error

### gemini-flash-lite (0)

### gpt-oss-groq (4)

- c001 "cafe 3500": http: http 400: Provider returned error
- c002 "Pague 12.000 de luz": http: http 400: Provider returned error
- c003 "gasté 8500 en la farmacai": http: http 400: Provider returned error
- c004 "subte 1200": http: http 400: Provider returned error
