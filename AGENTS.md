# Warren

Warren is a hosted, open-source ledger that any agent can plug into. A person signs up, forwards
their bank mail, gets a notice per operation on their phone, and connects their own agent
(Claude, ChatGPT or any MCP client). The agent supplies the model. Warren supplies what makes
the advice good: verified books, the person's profile and goals, and curated, dated facts. The goal is to give a person the best financial advice available for their real situation.

Start with `docs/architecture.md`. Research behind each slice is in `docs/research/`.

## The four rules

These hold in every change. A change that breaks one is wrong, whatever else it gains.

1. **The program does all arithmetic.** A model never adds, converts or rounds money. Amounts
   are decimal strings; tools return totals.
2. **Records are append-only.** A correction is a new row, enforced by database triggers and
   grants, never by convention.
3. **Raw mail never enters a model.** No tool, prompt or log returns raw mail, a transfer memo
   or the signed `To` address.
4. **DKIM must cover From, To, Date and Subject, and the signed To must name the user.** Mail
   that fails this is recorded as rejected, never parsed and never guessed at.

## The no-vendor rule

- Every outside service sits behind a port that `packages/core` owns: raw mail storage,
  inbound mail, outbound mail, scheduling, push, the clock.
- Each port ships with at least two implementations (the hosted one and a self-host or test
  one), so the interface is shaped by two real uses.
- A vendor SDK is imported only inside its adapter, in `packages/core/src/**/adapters/`. In the
  rest of `packages/core/src` an allow-list in `biome.json` (`noRestrictedImports` override)
  accepts only relative imports, `node:*` and the few listed packages, and fails `pnpm lint`
  otherwise. There is no deny-list to maintain: adding a core dependency means adding it to the
  allow-list deliberately.
- Two things are standards and are used directly: Postgres (plain SQL, no Neon-only features)
  and MCP.

## Layout

```
apps/web        Next.js 16 app: webhooks, sign-up/sign-in/home, /onboarding, /api/auth, the installable web app, push, /movements, and /api/mcp with its OAuth consent page
packages/core   Pure logic and ports: sender policy, DKIM, templates, ledger matching, notices
packages/db     Drizzle schema, SQL migrations (roles, RLS, triggers), asUser, mail log, ledger, outbox
scripts         Operator commands (mail:*, ledger:*, notice:*, mailbox:add, inbound:address, user:set-password, user:erase, db:tenancy-check, github-settings.sh)
docs            architecture.md and docs/research/ (dated research, not legal advice)
```

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome, including the no-vendor import rule
pnpm typecheck
pnpm test          # database tests run on an in-process Postgres
pnpm build
```

Pull requests are squash-merged, so the PR title becomes the commit and must be a Conventional
Commit (`feat:`, `fix:`, `docs:`, `chore:` ...). Every commit needs a sign-off: `git commit -s`.
See `CONTRIBUTING.md`.

## Supply chain

Pin GitHub Actions by full commit SHA with a version comment. Workflows default to
`permissions: contents: read`. Never use `pull_request_target` with a checkout of the pull
request. pnpm refuses releases younger than `minimumReleaseAge` and install scripts outside
`allowBuilds`; do not widen either to make an install pass without a reason in the commit.

## Slices

Each slice has a proof that can fail. Details are in `docs/architecture.md`.

0. Gate: this repository's rules, checks and settings.
1. Users: Better Auth, `user_id` and row-level security everywhere, per-user hash chain and keys.
2. Card purchases: a template for "Compra aprobada"; reparse stored mail.
3. PWA and push; the former WhatsApp notifier is deleted. Done.
4. Agent spike: `/api/mcp` with OAuth and one read tool. Done.
5. Advice kit, first cut: profile, general parameterised knowledge base with dated facts, two MCP prompts, fact tools, evals. Done.
6. Onboarding by forwarding: per-user address, Gmail confirmation, filter helper. Done.
7. Belo: sender policy and templates if its mail is signed.
8. Rules and allowance.
9. Import of the maintainer's own history and a ledger check against it.
10. Questions and fixed-time summaries.
11. Full tool layer and the contributor kit (redaction command, bank-template guide).
12. Self-host kit: IMAP poller, filesystem and S3 stores, worker, Docker Compose.
13. Before strangers sign up: legal review, data-protection registration, privacy policy.

Every row belongs to a user and the app reaches the database only through `asUser`; personal
data is sealed under a per-user key (`packages/core/src/crypto`). Each notice is pushed (Web Push, VAPID)
to every browser its user has subscribed. Sign-in (Better Auth, as `warren_auth`) is done; sign-up stays
closed to strangers (`WARREN_SIGNUP_EMAILS`) until slice 13.
