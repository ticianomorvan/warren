# eve spike: running the scenarios through eve

Spike code (see `docs/eve-spike.md`). Nothing here touches production: the ledger is a throwaway local
Postgres, WhatsApp is a fake Graph on `127.0.0.1`, and the model is Anthropic direct (`.env`).

```sh
# 1. Throwaway Postgres: one database for the core's ledger, one for eve's workflow world.
docker run --rm -d --name warren-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17
docker exec warren-pg-test psql -U postgres -c "CREATE DATABASE warren_ledger" -c "CREATE DATABASE workflow"

# 2. The eve server (build, then start). The environment, in a file or exported:
#    ANTHROPIC_API_KEY           from .env (never printed)
#    WORKFLOW_POSTGRES_URL       postgres://postgres:test@localhost:55432/workflow
#    WARREN_DATABASE_URL         postgres://postgres:test@localhost:55432/warren_ledger
#    SPIKE_SECRET                any string; the HTTP and MCP channels' stand-in auth
#    WARREN_SPIKE_GRAPH_URL      http://127.0.0.1:3199 (the fake Graph; the WhatsApp channel refuses to start without it)
WORKFLOW_POSTGRES_URL=... pnpm exec bootstrap        # once: the workflow world's schema
pnpm exec eve build && pnpm exec eve start --port 3100

# 3. The scenarios, graded by evals/scenarios/grade.ts (empties the throwaway ledger first).
pnpm tsx evals/eve/run.ts --split dev [--only s001,s002] [--budget 0.30] [--concurrency 4]
pnpm tsx evals/eve/run.ts --split all       # once per round: the test split is held out, counts only

# 4. The loop and eve side by side (newest two --split all runs of each).
pnpm tsx evals/eve/compare.ts 2
```

- `drive.ts` posts signed Meta webhooks to the Chat SDK WhatsApp channel and reads each reply off the fake Graph
  (`fake-graph.ts`). A turn with a photo goes over the HTTP channel instead (the adapter refuses to download
  media from a loopback host), through the same `finalize()` the WhatsApp channel uses.
- `timeline.ts` prints where the time of a turn goes (model calls, tool, checkpoint gaps) from event timestamps.
- `probe.ts` sends one message through WhatsApp; `guard-probe.ts` asks for an id the agent was never shown.
- The scenarios' fake clock is a `spike_clock` row per sender (a test seam in `agent/lib/core.ts`); production
  would use the message's own time.
