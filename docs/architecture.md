# Architecture

Status: plan of 2026-11-17. This replaces earlier plans that put a chat bot (WhatsApp, an agent
runtime) at the centre. Research behind each slice is in [`docs/research/`](research/) (dated,
not legal advice).

## Goal

Warren exists to give a person the best financial advice available for their real situation.
Anyone can sign up on one hosted instance, forward their bank mail, get a notice per operation
on their phone, and connect their own agent (Claude, ChatGPT, any MCP client). The agent
supplies the model; Warren supplies what makes the advice good: verified books, the person's
profile and goals, and a curated, dated knowledge base. The code is open source (MIT).

Three checks say whether it works:

- **The advice.** A fixed set of questions, asked through a connected agent, gets answers that
  quote ledger figures from tools, cite dated facts, and refuse the known traps (slice 5
  defines the set).
- **The maintainer's month.** For one full calendar month, the ledger's totals equal the
  totals the maintainer kept by hand, and the old tooling stays off.
- **A stranger's first hour.** A second account on a fresh Gmail goes from sign-up to its first
  parsed movement and its first agent answer without a terminal, an environment variable or the
  maintainer's help.

## The rules

1. The program does all arithmetic. A model never does.
2. Records are append-only. A correction is a new row, enforced by triggers and grants.
3. Raw mail never enters a model.
4. Mail counts only when the bank's DKIM signature covers From, To, Date and Subject, and the
   signed To names the user.

**No vendor in the core.** Every outside service sits behind a port that `packages/core` owns:
raw mail storage, inbound mail, outbound mail, scheduling, push, the clock. Each port ships with
at least two implementations, the hosted one and a self-host or test one (Blob and
S3/filesystem; Resend and an IMAP poll; Vercel Cron and a worker), so the interface is shaped by
two real uses and not guessed. Two things are standards and are not wrapped: Postgres (plain
SQL, no Neon-only features) and MCP. A vendor SDK may be imported only inside its adapter; a
lint rule checks.

## Not doing

- Running an agent loop or a model on Warren's bill. Warren is what other people's agents
  connect to. There is no in-app chat.
- WhatsApp and a chat runtime. The former WhatsApp notifier, its webhook route and its settings
  were deleted in slice 3.
- "Connect Gmail" by OAuth. `gmail.readonly` is a restricted scope: verification plus a yearly
  outside security assessment, and test-mode tokens expire in 7 days. Forwarding needs neither
  and gives Warren no inbox access.
- Opening sign-up to strangers before a lawyer has read the advice feature. Personalised advice
  to other people may be a CNV (Argentine securities regulator) matter. Building and using it
  for oneself is not blocked.
- Banks other than BBVA and Belo, self-host packaging, statement PDFs and native apps at the
  start. Later, by contribution.

## What exists today

A single-owner pipeline: a Gmail filter forwards bank alerts to a Resend inbound address; the
webhook (`apps/web/app/api/inbound/resend/route.ts`) stores the raw mail in Blob and Postgres;
DKIM is checked; templates parse the mail; a hash-chained ledger records the movement; an
outbox pushes a notice (Web Push) to every browser the user has subscribed. `packages/core`
reaches I/O through ports, so the notice sender is one adapter.

Slice 1 has removed the single-owner assumptions: every row has a `user_id`, the hash chain is
per user, mail is routed by the `To` header to the user who registered that mailbox, personal
data is sealed under a per-user key, and people sign in with Better Auth (email and password;
sign-up is gated by an operator's allow-list until slice 13). Slice 3 is done in shape: notices
are pushed to each user's own browsers, with an installable web app and a movements page, and
the former WhatsApp notifier (which reached one number and served one user) is deleted.

## Design

1. **Ledger service, multi-tenant.** Next.js 16 on Vercel, Neon, Drizzle, Blob, Resend. Every
   row carries `user_id`; the hash chain is per user; Postgres row-level security backs the
   triggers and roles, so a missing filter in app code cannot leak another user's rows. Mail is
   routed by the recipient address (a random token per user) and still counts only when the
   bank's signature covers a To that the user confirmed as theirs.
2. **Sign-in and agent authorization: Better Auth.** Passkey and email code for people. Its MCP
   plugin makes the same app the OAuth 2.1 authorization server for agents, with client ID
   metadata documents only: dynamic registration is off, as the MCP spec deprecates it. Clients are
   allow-listed by exact client id (Claude's two today). Sign-up starts invite-only.
3. **Tool layer.** `/api/mcp` on the MCP SDK directly, tokens checked for audience, 401 carrying
   `resource_metadata`. Read tools: movements, allowance, summaries, open questions. Write tools
   append one event each: classify, answer, add rule. No tool returns raw mail or a transfer
   memo.
4. **Advice kit, served over the same MCP endpoint.** A profile per user (income, goals,
   obligations, risk limits) as append-only rows; a shared knowledge base of principles, traps
   and dated facts with `review_by`, written in slice 5; and MCP prompts ("review my
   month", "should I...") that tell the agent to fetch figures and facts through tools, label
   any fact past its date as stale, and say it is not a licensed adviser. The knowledge base is
   files in the repository, so improving the advice is a pull request.
5. **PWA for the person.** Onboarding, movements, questions, rules, settings, "connect your
   agent". Notices go out as Web Push (`web-push`, VAPID, a hand-written service worker,
   subscriptions in Postgres) through the existing outbox. Push is best-effort, so the notice
   list in the app is the record and the push is the nudge. iOS needs the app on the Home
   Screen first; onboarding says so.
6. **Onboarding by forwarding, close to one click.** Warren shows the user's address, receives
   Gmail's confirmation mail itself and shows its confirm link, then gives a prefilled filter
   per bank and waits for the first mail.
7. **Banks as templates.** A bank is a sender policy plus templates plus redacted fixtures. A
   redaction command turns a real `.eml` into a fixture, which makes "add my bank" a small pull
   request.

**Rejected: self-host only.** No responsibility for other people's data, but every user would
create four vendor accounts, which is the opposite of the onboarding wanted. Self-hosting stays
possible because the code is open.

**Costs accepted.** Warren holds other people's financial data: export, deletion and a breach
plan are part of the product. A per-purchase push within a minute cannot be guaranteed. In a
user's agent nothing stops the model adding numbers itself; code-only arithmetic is enforced on
what Warren sends and encouraged by tools that return totals.

## Slices

Each slice names its research file and a proof that can fail. Read the file before building.

0. **Gate.** `AGENTS.md` with the four rules and the no-vendor rule. A ruleset on `main`: pull
   request required, 0 approvals, required checks, no force push. Actions pinned by commit with
   read-only default permissions; pnpm `minimumReleaseAge` and an install-script allow list;
   Renovate; secret scanning and push protection; DCO check; Conventional Commit titles with
   squash merge. `SECURITY.md`, `TRADEMARK.md`, `LICENSE` (MIT).
   Research: `research/repository.md`.
   Proof: the ruleset lists the rule; a pull request without sign-off fails the DCO check.
1. **Users** (`research/code.md` sections 1 and 5). Two steps, each one pull request.
   Step 1, the database baseline: the single-owner migrations are replaced by a baseline in
   which users, row-level security and sealing exist from the first migration (production's
   ledger is rebuilt from its raw mail with `pnpm mail:reingest`, not migrated). `user_id` and
   RLS policies on every table; every primary, unique and foreign key made per user, so two
   users can share a counterparty's account number and neither can learn the other has it;
   `asUser(db, id, fn)` sets `app.user_id` per transaction and is the only way the app reaches
   the database; the chain trigger locks and links per user; the recipient address resolves to
   a user through a `SECURITY DEFINER` function over a `mailbox` table that only the operator
   writes. Personal fields and raw mail are encrypted with AES-256-GCM under a per-user key,
   stored wrapped by a master key from the environment (no cloud KMS, per the no-vendor rule);
   a mail's identity is an HMAC under that key; the chain hashes the ciphertext, so erasing a
   user (a dedicated `warren_eraser` role deletes their key, their clear-text rows and files, under
   a lock that makes it wait for work in flight) leaves
   every chain verifying. Better Auth's tables (and its database-backed rate limiter) belong to
   their own role, `warren_auth`, and `warren_app` has no grant on them; erasing a user also has
   `warren_auth` delete their sessions and credentials and scrub the email and name of the
   `user` row, which stays.
   Step 2, sign-in: Better Auth (email and password), sign-up, sign-in and sign-out pages, and
   a signed-in home that shows the user's movement count.
   Proof, step 1: a tenancy test as the app role reads zero of user A's rows as user B on every
   table; CI fails if a table with `user_id` has no policy or a key that does not start with
   `user_id`; erasing a test user leaves the other chains verifying; `pnpm db:tenancy-check`
   passes against a Neon branch through the pooler, and fails with one policy dropped.
   Proof, step 2: in a browser, a new account signs up and signs in and sees no movements,
   while user 1 sees theirs.
2. **Card purchases.** Port "Compra aprobada"; reparse stored mail.
   Proof: `pnpm mail:parse-pending && pnpm mail:status` shows them parsed; each remaining
   unparsed row is named.
3. **PWA and push, WhatsApp out.** Manifest, service worker, push adapter, movements page; the
   former WhatsApp code is deleted (done). Old attempt rows stay as history.
   Proof: a real purchase raises a push on an Android phone and appears in the app;
   the vendor name of the former notifier appears nowhere in the repository.
4. **Agent spike.** `/api/mcp` with OAuth and one read tool (done: `ledger_list_movements`).
   Proof: "my last five movements" answered in a Claude app and in Claude Code; `curl` without a
   token gets 401 with `resource_metadata`; user B's token returns none of user A's rows. Tools
   follow `research/code.md` section 2: prefixed snake_case names, `readOnlyHint`,
   `outputSchema`, `structuredContent` with decimal-string amounts, cursor pagination, a size
   cap.
5. **Advice kit, first cut.** Profile, two MCP prompts, fact tools, and the knowledge base, written in this slice
   as general, parameterised content (principles, traps, rules) whose facts carry dates and
   `review_by`; it describes no one person's situation. Content stays general and names no securities (`research/legal-and-banks.md`
   section 1); personal reasoning is the agent's. CI gets the free eval tier: MCP contract
   tests, a grounding check, recorded transcripts replayed.
   Proof: a written set of ten questions (three of them traps) asked in Claude; a test that a
   fact past `review_by` comes back labelled stale; a test that no advice tool returns raw mail
   fields.
6. **Onboarding.** Per-user address, captured Gmail confirmation, filter helper, first-mail
   check, agent connect page.
   Proof: the stranger's first hour, recorded in a browser on a fresh Gmail account.
   Done 2026-11-19:
   - **Built:** mail is routed by the delivered-to token `u-<token>@in.heywarren.app`, and rule 4 is
     unchanged. Gmail's confirmation is captured under Google DKIM, and the mailbox is claimed through
     `claim_mailbox`. `/onboarding` has six steps and a filter file generated from `SENDERS`.
   - **Proved:** the maintainer re-onboarded through the page, and a bank mail delivered to their token
     verified. A second Google account was recorded from sign-up to "waiting for the first mail",
     including the filter import.
   - **Open:**
     - Remove the legacy To-header route once a week passes without it being used (the webhook logs
       `routedBy`).
     - Warn on the page about Google's phone challenge, which Gmail shows when a forwarding address
       is added and again on filter import.
     - Settle the one-click Gmail API option, which needs a restricted scope and a yearly security
       assessment, with a free test project before slice 13.
7. **Belo.** Forward real Belo mails; sender policy and templates if they are signed.
   Proof: `pnpm mail:verify belo.eml` passes, then a Belo operation appears as a movement.
8. **Rules and allowance.** Per-user rules and budgets; notices end with the amount left.
   Proof: golden allowance cases pass in `pnpm test`.
9. **Maintainer's cut-over.** Import the maintainer's own history for user 1; a ledger check
   exits 0 against the maintainer's hand-kept totals or lists every difference.
10. **Questions and fixed-time summaries.** Answer buttons in the app and on the notification;
    cron per user timezone.
    Proof: a fixed-clock test per summary; one real tap reclassifies a movement.
11. **Full tool layer and the contributor kit.** Remaining tools; `scripts/mail-redact.ts`
    (parser tests read the redacted body, DKIM tests re-sign it with the test signer) and a
    fixture lint; bank-template guide, issue forms, CODEOWNERS; Spanish and English through
    next-intl.
    Proof: a test per tool that no response carries raw mail fields; a fixture made by the
    redaction command passes.
12. **Self-host kit.** `MailSource` port with an IMAP poller; filesystem and S3 raw stores
    (SeaweedFS or Garage, not MinIO, archived April 2026); a worker for scheduled jobs;
    `output: 'standalone'`; Docker Compose.
    Proof: `docker compose up` on a clean machine takes a forwarded mail, read over IMAP, to a
    movement and a push; the IMAP copy still passes DKIM verification (unproven so far).
13. **Before strangers sign up.** A lawyer answers the questions in
    `research/legal-and-banks.md`; data-protection registration (AAIP); AAIP model clauses with
    the hosting providers; privacy policy and terms; deletion within 5 business days and access
    within 10 days work end to end; a paid hosting plan.
    Proof: the lawyer's written answers are on file, and the deletion test from slice 1 runs
    against production for a test account.

## Decided (2026-11-17)

- The web app is setup, dashboard and manual actions. Conversation happens in the user's agent
  over MCP; no chat.
- Licence: MIT. The name and domain are covered by `TRADEMARK.md`.
- Belo sends operation mail from `transaction@belo.app`; only that address goes in the sender
  policy. Whether it is DKIM-signed with a To that names the user is unproven and is slice 7's
  first check.
- Name: Warren. Domain: `heywarren.app`. The app is served at the root; inbound mail uses a
  subdomain (`in.heywarren.app`) so the mail provider's MX record does not take over the root's
  mail.
