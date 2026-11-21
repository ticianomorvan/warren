# Warren

A WhatsApp expense agent for Argentina. Write "café 3500 y súper 12.000 con la visa, ayer 20
lucas de nafta" and get one compact reply with each movement it understood. Correct it in plain
words, ask "¿cuánto gasté este mes en super?". The model only parses the message into a typed
command; code does the arithmetic, stores movements with their source message and writes the
reply. The design is in [`docs/spec.md`](docs/spec.md); rules and layout are in
[`AGENTS.md`](AGENTS.md).

The earlier mail-ledger version lives on as the tag `v0-mail-ledger`.

## Status

Fresh start, slice 1 of 4 done: the message parser (`src/parse`), a 131-message eval set and the
model choice. No webhook, database or deploy yet.

**Model choice: `claude-haiku-5-5`** at effort `low`, thinking off. On the held-out test split
(25 messages) both Haiku and Sonnet 5.5 are 25/25 fully correct with no silently wrong amount, so
the cheaper and faster one wins: about US$0.00016 and 1.0 s p50 per message, against US$0.0023
and 2.1 s for Sonnet. Details in the "Slice 1 result" section of the spec and in
`evals/results/summary.md`.

## Run it

Node 24 and pnpm.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

To run the eval, put `ANTHROPIC_API_KEY` in a gitignored `.env`, then:

```sh
pnpm eval --model haiku --split dev          # tune on this
pnpm eval --model sonnet --split test        # held out: run once per model at the end
```

Options: `--model haiku|sonnet`, `--split dev|test|all`, `--concurrency N`, `--budget USD`. It
prints accuracy per field, silently wrong amounts, p50/p95 latency, token means, cache reads and
estimated cost, and writes a JSON file to `evals/results/`.

Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
