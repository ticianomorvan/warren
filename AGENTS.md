# Warren

Warren is a WhatsApp expense agent for people in Argentina. A person writes "café 3500 y súper
12.000 con la visa, ayer 20 lucas de nafta" and gets one compact reply listing what was
understood. They fix it in plain words ("no, el café fue 3800", "borrá el último") and ask simple
questions ("¿cuánto gasté este mes en super?"). The spec, with its slices and the Slice 1 result,
is in `docs/spec.md`. The previous mail-ledger product is the tag `v0-mail-ledger`.

## Rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** A model never adds, converts or rounds money. Amounts are
   decimal strings ("3500", "1500000.50"); code computes every total.
2. **The model is a parser.** One LLM call returns one typed command (`log`, `correct`, `delete`,
   `query`, `help`, `off_topic`). Code validates and executes it and renders the reply from a
   template. No agent loop, no free-form model replies.
3. **Corrections never overwrite a movement.** A correction is a new row that supersedes the old
   one, so history is kept.
4. **Secrets live only in the gitignored `.env`.** Never in code, logs, eval output or commits.

## Layout

```
src/parse/    parseMessage: schema.ts (command), prompt.ts (frozen system prompt + volatile part),
              models.ts (Haiku/Sonnet configs, prices), validate.ts (code-side checks), index.ts
src/time.ts   The Argentine calendar day
evals/        cases.jsonl (dev/test split), grade.ts, run.ts, results/ (gitignored but summary.md)
docs/spec.md  Source of truth for what is built and in which order
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome
pnpm typecheck
pnpm test          # Vitest, no network
pnpm eval [--model haiku|sonnet] [--split dev|test|all] [--concurrency N]   # calls the API, needs .env
```

`pnpm eval` spends money: tune the prompt on `--split dev` only and run `--split test` once per
model at the end. CI never calls the Anthropic API.

## Conventions

- Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional
  Commit (`feat:`, `fix:`, `docs:`, `chore:` ...). Every commit is signed off: `git commit -s`.
  See `CONTRIBUTING.md`.
- Pin GitHub Actions by full commit SHA with a version comment; workflows default to
  `permissions: contents: read`. Never use `pull_request_target` with a checkout of the pull
  request.
- pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside
  `allowBuilds` (`pnpm-workspace.yaml`). Do not widen either without a reason in the commit.
- Node 24 (`.nvmrc`), TypeScript strict, Biome formatting, Zod 4 for schemas.
