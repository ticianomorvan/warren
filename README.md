# Warren

A WhatsApp expense agent for Argentina, also reachable from Claude and other agents over MCP. Write "café 3500 y súper 12.000 con
la visa, ayer 20 lucas de nafta" and get one compact reply with each movement it understood. Correct it in plain words ("no, el café
fue 3800", "deshacer"), ask "¿cuánto gasté este mes en super?", set reminders and tell it things to remember.

The model only calls guarded tools; code checks every call, does all the arithmetic, keeps every version of every record and writes
the reply. The agent model is `claude-haiku-5-5`.

- [`AGENTS.md`](AGENTS.md): the rules every change keeps, the layout, the commands and the deploy.
- [`docs/design.md`](docs/design.md): how it works and why.
- [`evals/scenarios/results/latest.md`](evals/scenarios/results/latest.md): the scenario eval's latest numbers.

Earlier products live on as tags: `v0-mail-ledger` (a ledger from bank mail) and `v1-final` (this product before the rebuild).

## Run it

Node 24 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check                                       # lint, typecheck and tests; no network, no keys
```

To run the scenario eval, put `ANTHROPIC_API_KEY` in a gitignored `.env`, then:

```sh
pnpm eval:scenarios --split dev                  # tune on this
pnpm eval:scenarios --split all                  # all of it, about US$0.17 a run
pnpm eval:report                                 # writes evals/scenarios/results/latest.md from the newest three runs
```

The `test` split is held out: never tune on it. Running the server (`pnpm start`) needs a database and the WhatsApp variables listed
in `AGENTS.md`.

Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md).
