# Contributing

Thank you for helping. Warren is maintained by one person, so please read this first.

- Review is not guaranteed and may be slow. Small pull requests get reviewed first.
- Bugs: open a pull request. Features: open an issue first and wait for a
  reply, so you do not build something that will not merge.
- If an AI tool helped write the change, say so in the pull request.

## The rules

A change must keep the six rules in [`AGENTS.md`](AGENTS.md): code does all arithmetic, every
write goes through the guarded tools, nothing is overwritten or deleted, a turn is the one unit
of work, secrets are never kept, and what Warren remembers about a person is theirs alone.

## Tests

`pnpm check` runs lint, typecheck and the whole suite on in-process PGlite, with Google and
claude.ai faked: no network and no keys. A change to anything that races (the account lock, the
undo stack) also needs the suite on a real Postgres; the command is in `AGENTS.md`.

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
