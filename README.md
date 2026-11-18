# Warren

A hosted, open-source ledger that any agent can plug into. Warren records every movement from
bank mail, keeps the books with deterministic code, and gives a person's own agent (Claude,
ChatGPT, any MCP client) verified figures, their goals and dated facts to advise
with. It never moves money, types credentials or places trades.

**Where to start:** [`AGENTS.md`](AGENTS.md) (rules and layout), [`docs/architecture.md`](docs/architecture.md)
(design and the slice plan, which supersedes earlier plans), [`CONTRIBUTING.md`](CONTRIBUTING.md).
Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md).

> The sections below describe the single-owner pipeline that exists today. The WhatsApp notices
> through Kapso are legacy: they are replaced by a web app and push notices in slice 3.

## Rules the code keeps

The four rules (arithmetic by code, append-only records, no raw mail in a model, DKIM must
cover the signed headers) and the no-vendor rule are in [`AGENTS.md`](AGENTS.md).

## What exists today (single-owner pipeline)

**Mail intake.** A Gmail filter forwards bank alerts to a Resend inbound address. Resend calls
`POST /api/inbound/resend`. The endpoint checks the webhook signature, downloads the raw mail,
stores it in a private Blob store under its SHA-256, records it in Postgres, and verifies the
bank's signature. Each mail ends as `verified`, `rejected` (with a reason) or `retry`.

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
the movement the first created. A transfer counts as the owner's own only when its
counterparty matches an identifier in the `account` table, which the app can read but not
write.

**Notices (legacy, removed in slice 3).** A movement first seen in a mail owes its owner one WhatsApp notice, queued in
the same transaction that creates the movement. The text is built by plain code from the
ledger (amount, accounts, counterparty, date) and sent through Kapso. Every attempt and every
delivery report from WhatsApp is a new row. When WhatsApp refuses free text because the owner
has not written in 24 hours, the notice goes out again through an approved template, if one
is configured. Kapso reports delivery to `POST /api/inbound/kapso`, signed with
`KAPSO_WEBHOOK_SECRET`.

```
apps/web        Next.js app; today only the inbound webhooks (Resend mail, Kapso delivery)
packages/core   Sender policy, DKIM verification, templates, matching, notices (I/O via ports)
packages/db     Drizzle schema, SQL migrations (triggers, roles), mail log, ledger, outbox
scripts         mail:*, ledger:* and notice:* commands
```

## Commands

```sh
pnpm install
pnpm test          # unit tests; the database tests run on an in-process Postgres
pnpm lint && pnpm typecheck && pnpm build
pnpm db:migrate    # applies migrations with DATABASE_URL_MIGRATIONS
pnpm mail:status   # latest mails and what Warren decided
pnpm ledger:status # latest movements
pnpm notice:status # latest notices and whether they were delivered
pnpm ledger:accounts   # add the owner's accounts from .data/accounts.json (kept out of git)
pnpm mail:verify some.eml --any-date   # check a saved mail against the sender policy
pnpm mail:parse-pending   # parse stored mail under the current templates; needs Blob access:
                          #   pnpm dlx vercel env pull .vercel/.env.development.local
```

## First deployment

1. **Neon**: create a project in São Paulo (`aws-sa-east-1`). Put the owner role's direct URL
   in `DATABASE_URL_MIGRATIONS` and run `pnpm db:migrate`. Then, in Neon's SQL editor:
   `alter role warren_app login password '<long random>';` and build `DATABASE_URL` from that
   role and the pooled host.
2. **Vercel**: create the project from your machine, since deploys run from GitHub Actions
   and not from Vercel's Git integration: `pnpm dlx vercel link` at the repository root,
   then set Root Directory to `apps/web` in the project settings. Create a private Blob
   store and connect it. Set `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` and
   `WARREN_OWNER_ADDRESSES` for Production. In GitHub, add the secrets `VERCEL_TOKEN` and
   `DATABASE_URL_MIGRATIONS`, and the variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`
   (both are in `.vercel/project.json` after linking). Every push to `main` that passes
   the checks then migrates the database and deploys.
3. **Resend**: note the receiving address (`<anything>@<id>.resend.app`). Add a webhook for
   `email.received` pointing to `https://<deployment>/api/inbound/resend` and copy its
   signing secret into Vercel.
4. **Gmail**: add the Resend address under Settings → Forwarding (Resend shows the
   confirmation mail under Receiving). Create a filter `from:(avisos@bbva.com.ar OR
   avisos-bbva-ar@bbva.com)` → Forward to that address.
5. Make a small transfer, then run `pnpm mail:status`. `verified` means forwarding kept the
   bank's signature intact.

Real mail files never go in this repository; `.gitignore` blocks `*.eml`.
