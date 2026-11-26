# Contributing

Thank you for helping. Warren is maintained by one person, so please read this first.

- Review is not guaranteed and may be slow. Small pull requests get reviewed first.
- Bugs: open a pull request. Features: open an issue first and wait for a
  reply, so you do not build something that will not merge.
- If an AI tool helped write the change, say so in the pull request.

## The rules

A change must keep the six rules in [`AGENTS.md`](AGENTS.md): code does all arithmetic, the
model acts only through guarded tools, nothing is overwritten or deleted, a turn is the one unit
of work, secrets are never kept, and what Warren remembers about a person is theirs alone.

## Eval

`pnpm eval:scenarios` calls the Anthropic API and costs money (about US$0.17 for a whole run),
so CI does not run it. If you change the agent (prompt, tools, context), run
`pnpm eval:scenarios --split dev` while you work and paste the numbers in the pull request. The
bar for merging is in [`docs/design.md`](docs/design.md) ("Tests and evals"). The `test` split
is held out: do not tune against its failures.

## Sign-off (DCO)

Every commit needs a `Signed-off-by` line, which certifies you wrote the change or may submit
it under the project's licence ([Developer Certificate of Origin](https://developercertificate.org/)).
Add it with:

```sh
git commit -s
```

To fix a commit that lacks it: `git commit -s --amend` (or `git rebase --signoff main` for a
branch). Contributions are licensed under MIT, like the rest of the code. There is no CLA.

## Commits and pull requests

- Pull requests are squash-merged. The pull request title becomes the commit, so it must be a
  [Conventional Commit](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`,
  `docs: ...`, `chore: ...`, `refactor: ...`, `test: ...`, `ci: ...`, `build: ...`.
  A check enforces it.
- The title is the commit message on `main`, so it is what the history and later release notes show.
- Before opening: `pnpm install --frozen-lockfile && pnpm check` (lint, typecheck and tests).

## Security

Do not report vulnerabilities in public issues. See `SECURITY.md`.
