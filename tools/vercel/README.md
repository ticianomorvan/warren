# Vercel CLI for the deploy job

The deploy job in `.github/workflows/ci.yml` installs the Vercel CLI from this folder with npm,
not through the pnpm workspace.

Why: since `vercel@58.5.1` (2026-08-03), Vercel publishes its CLI from a private repository, so
its packages carry no npm provenance attestation. pnpm's `trustPolicy: no-downgrade` therefore
rejects every current `vercel` and `@vercel/*` release, and Vercel says this is expected
([vercel/vercel#17408](https://github.com/vercel/vercel/issues/17408)). Keeping the CLI here
leaves the workspace's trust policy whole for everything else.

What still protects the deploy:

- `package-lock.json` pins the CLI's whole dependency tree, each package by its sha512 hash, and
  the job installs it with `npm ci`.
- `.npmrc` sets `ignore-scripts=true`, so no install script runs.
- `verify.sh`, run by the check job on every pull request and again before installing, checks that the lockfile's hash for `vercel` equals the one Vercel
  publishes at `https://vercel.com/docs/cli/release-notes/npm/<version>/integrity`.

What it does not cover: the publish trust of the CLI's own dependencies, which Vercel's packages
cannot pass.

To update: Renovate proposes new versions after 3 days. By hand, change the version in
`package.json` and run `npm install --package-lock-only` here.
