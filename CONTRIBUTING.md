# Contributing

Thank you for helping. Warren is maintained by one person, so please read this first.

- Review is not guaranteed and may be slow. Small pull requests get reviewed first.
- Bugs and bank templates: open a pull request. Features: open an issue first and wait for a
  reply, so you do not build something that will not merge.
- If an AI tool helped write the change, say so in the pull request.

## The rules

A change must keep the four rules in [`AGENTS.md`](AGENTS.md): code does the arithmetic, the
model only parses, corrections keep history, secrets stay in `.env`.

## Eval

`pnpm eval` calls the Anthropic API and costs money, so CI does not run it. If you change the
prompt, say what you ran and paste the dev-split numbers in the pull request. The test split is
held out: do not tune against its failures.

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
- Before opening: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`.

## Security

Do not report vulnerabilities in public issues. See `SECURITY.md`.
