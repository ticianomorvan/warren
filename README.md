# Warren

A hosted, open-source ledger that any agent can plug into. Warren records every movement from
bank mail, keeps the books with deterministic code, and gives a person's own agent (Claude,
ChatGPT, any MCP client) verified figures, their goals and dated facts to advise
with. It never moves money, types credentials or places trades.

**Where to start:** [`AGENTS.md`](AGENTS.md) (rules and layout), [`docs/architecture.md`](docs/architecture.md)
(design and the slice plan, which supersedes earlier plans), [`CONTRIBUTING.md`](CONTRIBUTING.md).
Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md).

> The sections below describe the pipeline as it stands after the second step of slice 1: every
> row belongs to a user, Postgres row-level security keeps users apart, personal data is
> sealed under a per-user key, and people can sign in with email and password. Sign-up is closed
> to strangers (an operator's allow-list), and mailboxes are still registered by the operator.
> The WhatsApp notices through Kapso are legacy: they are replaced by a web app and push
> notices in slice 3.

## Rules the code keeps

The four rules (arithmetic by code, append-only records, no raw mail in a model, DKIM must
cover the signed headers) and the no-vendor rule are in [`AGENTS.md`](AGENTS.md).

## What exists today

**Mail intake.** A Gmail filter forwards bank alerts to a Resend inbound address. Resend calls
`POST /api/inbound/resend`. The endpoint checks the webhook signature and downloads the raw
mail. It reads the (unsigned) `To` header to find the user who registered that address; mail
nobody claims is noted without content and answered with success. For the user it found, it
seals the mail with their key and stores it in a private Blob store (`u/<user id>/mail/<mail
id>.eml.sealed`), records it in Postgres, and verifies the bank's signature. The mail's identity
is an HMAC under the user's key, not a plain SHA-256. Rule 4 still decides: the signed `To` must
name one of that user's mailboxes. Each mail ends as `verified`, `rejected` (with a reason) or
`retry`.

**Mail parsing.** A verified mail is matched to a template by its sender and signed Subject,
and the template reads typed, validated fields out of the HTML (amount as a decimal string,
CBU and CUIT check digits, date close to the signed Date). A mail no template can read is
recorded as `unparsed` with the reason; it is never dropped and never guessed at.

| Template                 | Mail                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `bbva.transfer-sent`     | "Realizaste una transferencia"                                                     |
| `bbva.transfer-debited`  | "AVISO TRANSFERENCIA INMEDIATA DEBITADA"                                           |
| `bbva.transfer-credited` | "AVISO TRANSFERENCIA INMEDIATA ACREDITADA" (not yet confirmed against a real mail) |

Changing a template means bumping its `version` and `TEMPLATE_SET_VERSION`; stored mail is then
parsed again as new rows by `pnpm mail:parse-pending`.

**Ledger.** A parsed mail becomes a movement. The record of truth is an append-only event
log whose rows are hash-chained; the `movement` table is derived from it. One real operation
is one movement: BBVA sends two mails for an outgoing transfer, and the second is linked to
the movement the first created. A transfer counts as the user's own only when its
counterparty matches an identifier in the `account` table, which the app can read but not
write. Each user has their own chain, and it hashes the sealed payload.

**Users and privacy.** Every table has `user_id`, and every key starts with it. The app reaches
the database only through `asUser(db, userId, fn)`, which opens a transaction, sets `app.user_id`
for that transaction alone, and loads the user's data key; row-level security then shows the
callback only that user's rows. Personal columns (event payloads, parsed operations, verdict
subjects, notice texts) and raw mail are sealed with AES-256-GCM under a random per-user key,
which is stored wrapped by `WARREN_MASTER_KEY`. Erasing a user (`pnpm user:erase`) destroys their
key and deletes everything of theirs that is in clear (movements, sources, notices, mailboxes,
account names and identifiers) and their files; their append-only rows stay as ciphertext
nobody can open, and every chain still verifies. Each table is tagged once in
`packages/db/src/tables.ts` (erased with the user, or kept with a reviewed list of columns), and
tests compare the tags with the eraser's real grants, policies and triggers. Neon's history keeps the wrapped key for its history
window. Better Auth's tables are reachable only by their own role, `warren_auth`.

**Sign-in.** Better Auth, with email and password only: no mail is sent yet, so there is no
verification and no reset. It connects as its own role, `warren_auth` (`DATABASE_URL_AUTH`), and
`app/api/auth/[...all]` serves it. `proxy.ts` sends anyone without a session to `/sign-in`, and
checks the session against the database, not just the cookie. Pages: sign-up, sign-in, and a home
that shows the signed-in user's movement count through `asUser`; every string is in
`apps/web/lib/strings.ts`. **Sign-up is closed to strangers** until slice 13: only emails in
`WARREN_SIGNUP_EMAILS` (comma separated; unset means nobody) can create an account. The gate is
a Better Auth database hook, so no route skips it. Because nothing is mailed yet, an allow-listed
address belongs to whoever signs up with it first: list an address when its owner is about to sign
up, and take it off afterwards. A new user's data key is made at sign-up (and by `asUser` on first
use otherwise). `pnpm user:set-password --user <id>` gives a user a password, or replaces it, for
the user made by hand at the reset or anyone who forgot: it reads the password from stdin, never
an argument.

**Notices (legacy, removed in slice 3).** A movement first seen in a mail owes its user one notice,
queued in the same transaction that creates the movement. The WhatsApp channel reaches one number,
so it serves one user (`WARREN_KAPSO_USER_ID`); the notices of anyone else wait for push. The text is built by plain code from the
ledger (amount, accounts, counterparty, date) and sent through Kapso. Every attempt and every
delivery report from WhatsApp is a new row. When WhatsApp refuses free text because the recipient
has not written in 24 hours, the notice goes out again through an approved template, if one
is configured. Kapso reports delivery to `POST /api/inbound/kapso`, signed with
`KAPSO_WEBHOOK_SECRET`; the status names only a message id, so a `security definer` function
(`user_for_wamid`) finds the user first.

```
apps/web        Next.js app: sign-up, sign-in and home pages, /api/auth, the inbound webhooks (Resend mail, Kapso delivery)
packages/core   Sender policy, DKIM verification, templates, matching, notices, sealing (I/O via ports)
packages/db     Drizzle schema, SQL migrations (roles, RLS, triggers), asUser, mail log, ledger, outbox
scripts         mail:*, ledger:*, notice:*, mailbox:add, user:set-password, user:erase and db:tenancy-check commands
```

## Commands

```sh
pnpm install
pnpm test          # unit tests; the database tests run on an in-process Postgres
pnpm lint && pnpm typecheck && pnpm build
pnpm db:migrate    # applies migrations with DATABASE_URL_MIGRATIONS
pnpm db:tenancy-check <warren_app url> --owner <owner url> [--auth <url>] [--negative]
                   # proves, on a Neon branch through the pooler, that users are kept apart
pnpm mailbox:add --user <id> you@example.com   # register the address a user forwards bank mail to
pnpm mail:status --user <id>      # latest mails and what Warren decided, then the totals
pnpm ledger:status --user <id>    # latest movements
pnpm notice:status --user <id>    # latest notices and whether they were delivered
pnpm ledger:accounts --user <id>  # add the user's accounts from .data/accounts.json (kept out of git)
pnpm mail:verify some.eml --mailbox you@example.com --any-date   # check a saved mail against the sender policy
pnpm mail:parse-pending --user <id>   # parse stored mail under the current templates; needs Blob access:
                                      #   pnpm dlx vercel env pull .vercel/.env.development.local
                                      # a movement it records owes a notice only if its mail is under 24 h old
pnpm mail:reingest --user <id> --from <archive url>   # replay an old database's raw mail into the new ledger
pnpm mail:replay-unrouted [--dry-run]   # run mail that arrived before its mailbox existed through intake
pnpm user:set-password --user <id>   # set or replace a password (read from stdin; connects as warren_auth)
pnpm user:erase --user <id> --confirm   # destroy a user's key and derived data (as warren_eraser)
```

The scripts that read or write a user's data take `--user` and connect as `warren_app`
(`DATABASE_URL`), so row-level security applies to them too. The two that write what the app
may not, `ledger:accounts` and `mailbox:add`, connect as the owner and name the user in every
query.

## First deployment

1. **Neon**: create a project in São Paulo (`aws-sa-east-1`). Put the owner role's direct URL
   in `DATABASE_URL_MIGRATIONS` and run `pnpm db:migrate`. The first migration creates three
   roles without a login: `warren_app` (the deployed app), `warren_auth` (Better Auth) and
   `warren_eraser` (erasure). Give each a password in Neon's SQL editor, once:
   `alter role warren_app login password '<long random>';` and likewise for the other two, then
   build `DATABASE_URL`, `DATABASE_URL_AUTH` and `DATABASE_URL_ERASER` from them (the first two
   on the pooled host, which is where the user context could leak, so run
   `pnpm db:tenancy-check` against a branch before relying on it).
2. **Vercel**: create the project from your machine, since deploys run from GitHub Actions
   and not from Vercel's Git integration: `pnpm dlx vercel link` at the repository root,
   then set Root Directory to `apps/web` in the project settings. Create a private Blob
   store and connect it. Set `DATABASE_URL`, `DATABASE_URL_AUTH`, `WARREN_MASTER_KEY` (see
   `.env.example`; keep a copy outside Vercel: without it every user's sealed data is
   unreadable), `BETTER_AUTH_SECRET` (32+ random characters), `BETTER_AUTH_URL` (the app's public
   origin, `https://...`), `WARREN_SIGNUP_EMAILS` (who may sign up), `RESEND_API_KEY` and
   `RESEND_WEBHOOK_SECRET` for Production. In GitHub, add the secrets `VERCEL_TOKEN` and
   `DATABASE_URL_MIGRATIONS`, and the variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`
   (both are in `.vercel/project.json` after linking). Every push to `main` that passes
   the checks then migrates the database and deploys.
3. **Resend**: note the receiving address (`<anything>@<id>.resend.app`). Add a webhook for
   `email.received` pointing to `https://<deployment>/api/inbound/resend` and copy its
   signing secret into Vercel.
4. **A user and a mailbox.** Sign up at `/sign-up` with an allow-listed email (or, for a user
   made by hand, `pnpm user:set-password --user <id>`), then register the address
   their bank mail is addressed to: `pnpm mailbox:add --user <id> you@example.com`. Mail to an
   address nobody registered is dropped, noted without content, until `pnpm
   mail:replay-unrouted` runs it again once the mailbox exists.
5. **Gmail**: add the Resend address under Settings → Forwarding (Resend shows the
   confirmation mail under Receiving). Create a filter `from:(avisos@bbva.com.ar OR
   avisos-bbva-ar@bbva.com)` → Forward to that address.
6. Make a small transfer, then run `pnpm mail:status --user <id>`. `verified` means forwarding
   kept the bank's signature intact.

### Resetting production onto the new baseline

The baseline replaced the single-owner migrations, so an existing database is rebuilt, not
migrated. The deploy runs `pnpm db:migrate` on every merge, so do these in one sitting:

1. Take a Neon branch of production as the archive.
2. Drop the `public` and `drizzle` schemas (`drop schema public cascade; drop schema drizzle
   cascade; create schema public;`). The roles stay.
3. Merge, so the baseline migrates. Set the passwords of `warren_auth` and `warren_eraser`,
   `WARREN_MASTER_KEY`, and make the user row for user 1. **Add the mailbox immediately**
   (`pnpm mailbox:add --user <id> <address>`): from the migration until then, the live webhook
   finds no mailbox and drops each mail it receives, keeping only that something arrived.
   Then run `pnpm mail:replay-unrouted`, which fetches those deliveries from Resend again and
   runs them through intake (idempotent; `--dry-run` lists them first). A delivery stays listed
   until its mail is verified or rejected: one Resend can no longer return, or whose DNS check
   came back `retry`, is reported and the command exits 1; run it again until it exits 0. Mail
   that still matches no mailbox is listed as `unrouted` without failing the run. This is mail
   the user never saw, so a movement it creates owes a notice, except for mail older than the
   notice window (24 hours), which is recorded silently rather than sent late as if it were new.
4. `pnpm mail:reingest --user <id> --from <archive url>` replays the archive's raw mail through
   the new intake and prints the archive's verified and parsed counts against the new ledger,
   naming every mail that differs. It never notifies: a rebuild creates its movements without
   notices, because the user already saw them. Re-add the accounts with
   `pnpm ledger:accounts --user <id>`.
5. Delete the old content-addressed blobs (`raw/mail/<sha256>.eml`) only after the counts agree.

Real mail files never go in this repository; `.gitignore` blocks `*.eml`.
