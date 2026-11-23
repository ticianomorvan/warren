# Cutover runbook: v1 to the rebuild

The commands R9's thread runs against production, in order, with what each prints when it is fine. `scripts/cutover.ts` does the work and logs each step (to the terminal and to `cutover.log` in its work directory, never with a URL or a secret). Written against head of branch `rebuild`; the spec is `docs/rebuild-spec.md` section 7.

## What the cutover does and does not do

- It stops v1 first, so no write is lost between the dump and the switch. While v1 is down, Meta's webhooks get no 200 and are retried "with decreasing frequency, for up to 7 days" ([WhatsApp webhooks, Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)): a message sent in the gap arrives after the new version is up, in a burst, with duplicates the new `wa_message.wamid` key drops. (A WhatsApp number set to "No Storage" gets only 1 hour of retries; check that Warren's is not, in the app's WhatsApp settings, before you start.) The downtime is the dump (about 0.2 MB), the import (under a second) and one build: the staging rehearsal took about 50 s for v1 and 45 s for the rebuild.
- The new database is `warren_v2` **inside the existing Postgres service**, so `.railway/railway.ts` is unchanged and the old database `railway` stays as it was. The rollback is the old URL.
- **Writes to the new database after the cutover are not carried back by a rollback.** A rollback returns to v1's database as it was when v1 stopped (step 2).
- Production's Railway config changes only in draining and overlap (15 s each). The plan, checked today, says exactly:

```
Plan: 0 to add, 1 to change, 0 to destroy
  ~ Update warren deploy.drainingSeconds, deploy.overlapSeconds
    └ deploy.drainingSeconds (null → 15)
    └ deploy.overlapSeconds (null → 15)
```

The script runs `railway config plan` twice (at the start, and again just before the switch) and aborts on any destroy. `config apply` is never given `--confirm-destructive`.

## Before you start

1. This checkout, on branch `rebuild`, at the head you mean to ship, **clean and pushed** (`railway up` uploads the working directory).

   ```
   git status -sb          ## rebuild...origin/rebuild   (no changes listed)
   git rev-parse --short HEAD
   ```

2. CI green on that head (both jobs) and `pnpm probe staging --expect $(git rev-parse HEAD)` green (staging deploys from the branch). Prints `passed: 0 failure(s)`.
3. Tools: `railway whoami` answers; `docker ps` answers (the dump runs `pg_dump` from `postgres:18` when the machine has none); the Railway CLI is linked to project `warren` (`railway status` shows it).
4. Production is v1 and healthy: `pnpm probe production --expect v1`

   ```
   ok   health says build v1
   ok   mcp: 401 with a challenge and metadata, no token
   ok   oauth: discovery
   ok   health
   ok   webhook verify handshake
   passed: 0 failure(s)
   ```

5. The old `DATABASE_URL` is the reference the rollback sets back: `railway variables -s warren -e production --json` shows a URL on `postgres.railway.internal:5432/railway` (check the host and the database name only; do not print the password).
6. Rehearsal, already done on staging with this script: `tsx scripts/cutover.ts rollback --rehearse` deployed `v1-final` to staging on a scratch database, probed it with `--expect v1`, then deployed the rebuild again with `railway up` and probed it for its own deployment id. Run it again if the script changed since.

## The dry run (changes nothing in production)

```
tsx scripts/cutover.ts --dry-run
```

It reads production (plan, a `pg_dump`, the probe) and does everything else on a throwaway Docker Postgres. Prints, among the steps, `step 1/9: ok - Plan: 0 to add, 1 to change, 0 to destroy (...)`, `step 6/9: ok - 17 checks match`, `step 7/9: ok - unchanged; ...`, `step 9/9: ok - production probe passed` and `dry run complete: nothing in production was changed`. It deletes the dump when it passes.

## The cutover

```
tsx scripts/cutover.ts
```

What each step prints when it is fine:

| Step | What it does | Prints |
|---|---|---|
| 1/9 | `railway config plan --environment production --detailed-exit-code`; abort on any destroy | `ok - Plan: 0 to add, 1 to change, 0 to destroy (~ Update warren deploy.drainingSeconds, deploy.overlapSeconds)` |
| 2/9 | `railway down -s warren -e production --yes`, then polls until the newest deployment is not `SUCCESS` and `https://wa.heywarren.app/health` does not answer 200 | `ok - deployment xxxxxxxx is REMOVED; /health does not answer` |
| 3/9 | `pg_dump` of database `railway` (connection in the `PG*` environment, never on the command line) | `ok - <n> KB in <workdir>/old.sql` |
| 4/9 | `CREATE DATABASE "warren_v2"` in the same Postgres, then the migrations | `ok` (two `migration_applied` lines: `001_init.sql`, `002_auth.sql`) |
| 5/9 | import-v1: the old database read in one `REPEATABLE READ READ ONLY` transaction | `ok - N accounts, N movements, N facts, N reminders, N wa messages` (today's dry run: 1, 19, 2, 3, 113) |
| 6/9 | verify: counts, sums per currency, an md5 per account of what every live movement and reminder says, facts, reminder sends, auth tables, recent wamids | 17 lines starting `ok`, then `ok - 17 checks match`. Any `FAIL` line aborts before anything is switched |
| 7/9 | re-reads the old database: per table row count, highest id and newest row version must equal what the import read; plans again | `ok - unchanged; Plan: ...`. A table named as changed aborts |
| 8/9 | sets `DATABASE_URL` (the private URL of `warren_v2`, on stdin) with `--skip-deploys`; `railway config apply --environment production --yes`; `railway up -s warren -e production --ci` | `ok - deployment xxxxxxxx` |
| 9/9 | `pnpm probe production --expect <that deployment id>`: polls `/health` until its `x-warren-build` header names the deployment (up to 10 minutes), then the read-only probes | `ok   health says build xxxxxxxxxxxx`, the probe lines, `ok - production probe passed`, then `cutover complete. Next: Ticiano sends one WhatsApp message and one Claude message.` |

Then, by hand: the live check. Ticiano sends one WhatsApp message and one Claude message (`warren_summarize` over MCP is enough).

Afterwards: `rm <workdir>/old.sql` (the dump holds personal data; keep it only if the old database is not enough, which it should be), merge the PR (production deploys by upload, so a merge deploys nothing), and delete the staging environment.

### If a step fails

- Steps 1 and 2 failing: nothing was switched. If `railway down` ran, v1 is stopped: run the rollback below to bring it back (the rehearsed path).
- Steps 3 to 7 failing (a verification mismatch, a changed old database): `DATABASE_URL` was not touched; v1 is **stopped**. Read the failed line, then run the rollback (v1 comes back on its own database), or fix and re-run the script: a leftover `warren_v2` must be dropped first (`DROP DATABASE warren_v2` through the same connection; it has nothing worth keeping).
- Step 8 failing after the variable was set: run the rollback (it sets the variable back).
- Step 9 failing (the probe never saw the new build, or a probe line failed): look at `railway logs -s warren -e production`; if it is not a quick fix, roll back.

## Rollback

```
tsx scripts/cutover.ts rollback
```

| Step | Prints |
|---|---|
| `rollback 1/3` | `ok` (sets `DATABASE_URL` back to `${{Postgres.DATABASE_URL}}`, the old database, with `--skip-deploys`) |
| `rollback 2/3` | `ok - 066eb87 answers (no build header)`: checks the tag `v1-final` out into a temporary worktree, runs `railway up <tree> --path-as-root -s warren -e production --ci` **from this linked checkout** (Railway has no link for a temp directory), removes the worktree, then probes with `--expect v1`. A failure keeps Railway's stderr in the message |

Then `rolled back: run pnpm probe production --expect v1`. Run it. The rollback does not delete `warren_v2`; drop it when you are done looking at it. Anything written to `warren_v2` after the cutover is not in v1's database.

`tsx scripts/cutover.ts rollback --dry-run` prints the commands without running them.
