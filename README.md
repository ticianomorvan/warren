# Warren

A WhatsApp expense agent for Argentina. Write "café 3500 y súper 12.000 con la visa, ayer 20
lucas de nafta" and get one compact reply with each movement it understood. Correct it in plain
words, ask "¿cuánto gasté este mes en super?". The model only calls guarded tools (log, correct,
delete, summarize, ask); code validates them, does the arithmetic, stores movements with their
source message and writes the reply from templates. The design is in [`docs/rebuild-spec.md`](docs/rebuild-spec.md); rules and layout are in
[`AGENTS.md`](AGENTS.md).

The earlier mail-ledger version lives on as the tag `v0-mail-ledger`.

## Status

Rebuilt on one foundation (`docs/rebuild-spec.md`): one record per unit of work for every channel (WhatsApp and MCP), one write path, one
undo engine and one tool registry, with every reply rendered by code. The agent model is `claude-haiku-5-5` at effort `low`, thinking off.
The scenario eval's numbers are in `evals/scenarios/results/latest.md`.

## Run it

Node 24 and pnpm.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

To run the scenario eval, put `ANTHROPIC_API_KEY` in a gitignored `.env`, then:

```sh
pnpm eval:scenarios --split dev                  # tune on this
pnpm eval:scenarios --split all                  # all of it, about US$0.17 a run
pnpm eval:report                                 # writes evals/scenarios/results/latest.md from the newest three runs
```

It prints how many scenarios were fully right, silent wrong changes, invented numbers, latency and cost, and writes a JSON file to
`evals/scenarios/results/`. The `test` split is held out: never tune on it.

Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
