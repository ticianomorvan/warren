> Research as of 2026-11-17; not legal advice.

# Warren open source launch: repository research

Date: 2026-11-17. Scope: five questions on how to run the public repo.
Legend: VERIFIED means I read the primary page today (URL given). UNVERIFIED means a search snippet, memory, or my own reasoning. "Analysis" marks my inference, not a source claim.

## Recommendations

1. Keep MIT for the code. Decide the licence now and write the reason in the README. Plausible moved MIT to AGPL; Cal.com moved AGPL to MIT and closed the hosted code. Late switches cost trust.
2. Add `TRADEMARK.md` at launch. Model it on Plausible: name and logo are not licensed by the MIT code licence; factual references are fine; forks must rename and drop the logo; public hosted copies need written permission; self-hosters may use a subdomain with a disclaimer.
3. Do not register a trademark yet. Own the domain and handles, use the name consistently, and revisit when the hosted service has real users. Argentina details are UNVERIFIED (see Q2).
4. Use DCO (`Signed-off-by`), not a CLA. Enforce it with a small CI check. Say in CONTRIBUTING that contributions are under MIT.
5. Add `SECURITY.md` with a private channel (GitHub private vulnerability reporting plus an email), "latest release only" support, and a short threat model like Actual's. State clearly that the hosted instance is in scope and self-hosting is the operator's responsibility.
6. Turn on secret scanning and push protection, and add a CI secret scan over bank-mail fixtures. Contributed templates will contain mail samples. Require redacted fixtures.
7. In every workflow: pin actions by full commit SHA, set top-level `permissions: contents: read`, and never use `pull_request_target` with a PR checkout. Let Renovate keep the pins fresh (`helpers:pinGitHubActionDigests`).
8. In pnpm: set `minimumReleaseAge` (default is 1440 minutes, raise it to about 7 days), keep `strictDepBuilds: true` with a short `allowBuilds` list, set `trustPolicy: no-downgrade`, keep `blockExoticSubdeps: true`.
9. Use Renovate, not Dependabot, for the pnpm monorepo. Group non-major updates and automerge only after CI passes and the age gate holds.
10. Protect `main` with a ruleset: PR required, 0 required approvals, required status checks, block force pushes, linear history. Accept a low OpenSSF Code-Review score. Revisit when a second maintainer exists.
11. Enforce Conventional Commit PR titles with squash merge, and use release-please (simple or node type) for tags, changelog and GitHub Releases. Skip changesets: it targets published packages. Skip npm provenance; add GitHub artifact attestation only if you publish a Docker image for self-hosters.
12. Make the contribution path narrow: a "new bank template" guide, issue and PR templates, labels (`template`, `good first issue`, `needs-discussion`), CODEOWNERS on `/templates` and security-sensitive paths. State that review is not guaranteed, features need an issue first, and AI-assisted PRs must be disclosed. Recruit a second maintainer early.

## Q1. How comparable projects run

### Summary table

| Project           | Licence now                   | Hosted vs self-host                                     | Governance                            | Contribution rule                                            |
| ----------------- | ----------------------------- | ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Actual Budget     | MIT (GitHub API: `MIT`)       | Self-host; PikaPods third party; no official SaaS found | Community maintainer team, volunteers | No CLA/DCO found on the pages read; release-note file per PR |
| Firefly III       | AGPL-3.0                      | Self-host only; no official hosting                     | One developer, "side gig"             | DCO claim only from a snippet (UNVERIFIED)                   |
| Maybe Finance     | AGPL-3.0, archived 2025-07-27 | Company hosted briefly, then dissolved                  | Company                               | Repo closed to contributions at the end                      |
| Plausible         | AGPL-3.0 (tracker script MIT) | Cloud (paid) vs Community Edition twice a year          | Company (Plausible Insights OU)       | CONTRIBUTING; discuss features first; no CLA mentioned       |
| Cal.com / Cal.diy | Cal.diy MIT; Cal.com closed   | Hosted closed; Cal.diy self-host only                   | Company; interns became maintainers   | PR size rules; no CLA mentioned                              |

### Actual Budget

- Licence is MIT. VERIFIED: https://api.github.com/repos/actualbudget/actual (`license.spdx_id` = MIT, 30k stars).
- Origin: creator James Long built it commercially, then opened it. A small group of volunteers got access to the core repos. VERIFIED: https://actualbudget.org/blog/roadmap-for-2025 . Other detail on the handover comes from search results only: UNVERIFIED.
- Governance: the maintainer team "constantly changing"; maintainer attention treated as scarce; issues are closed to reduce distraction. VERIFIED: same roadmap post.
- Lessons stated by the project: the flood of contributions was "a blessing and a curse"; PRs "sat for months" without reviewers; the lead stepped back; others left. Donations via Open Collective, "We do not intend to make money off of Actual". VERIFIED: same post.
- Contributions: link an issue, add a release-note file via `yarn generate:release-notes` into `upcoming-release-notes/`, run typecheck and lint. "An open PR does not automatically deserve time for a full review and acceptance." Maintainers "aren't going to take every single little change." Bigger changes need an issue first. "Multiple maintainers are key to this being a healthy project." VERIFIED: https://actualbudget.org/docs/contributing/ . The page says nothing on CLA or DCO.
- Release process: notes compiled at next release; a "How to Cut a Release" guide exists but I did not read it. VERIFIED (partial): same page.
- AI policy: PR titles must be prefixed `[AI]` for AI-assisted work. VERIFIED: https://github.com/actualbudget/actual/blob/master/AGENTS.md
- Security: SECURITY.md uses GitHub private reporting, supports latest release only, and states a threat model (see Q3).

### Firefly III

- AGPL-3.0. VERIFIED: https://github.com/firefly-iii/firefly-iii and the GitHub API.
- One developer. "Firefly III is a side gig." Funding from Patreon, GitHub Sponsors, Ko-fi, Liberapay. No own hosted service; third parties (Hostinger, PikaPods) pay referral money. VERIFIED: the repo README page above.
- "It is completely self-hosted and isolated, and will never contact external servers until you explicitly tell it to." VERIFIED: same page.
- Contribution rules live in the docs site (docs.firefly-iii.org returned HTTP 403 to me). A search snippet said contributors must be sole authors, follow DCO, and that the process is "not suitable for automatic processing by AI tools". UNVERIFIED.
- Lesson (analysis): a single-maintainer project with no hosted product survives on sponsorship and a narrow scope, but it caps growth.

### Maybe Finance

- Repo archived by owner 2025-07-27, "no longer actively maintained". Licence AGPL-3.0. VERIFIED: https://github.com/maybe-finance/maybe
- Why: the final release says the team is pivoting to B2B forecasting; their "duty is to investors"; continuing the app "is not our best chance at paying back our investors". It is "as-is", no maintenance, no outside contributions. VERIFIED: https://github.com/maybe-finance/maybe/releases/tag/v0.6.0
- Earlier history: the company shut down the original business in mid-2023 after spending near $1M, then open-sourced the app. VERIFIED (as told by the fork): https://github.com/we-promise/sure (README "Backstory"). Founder's reasons for failure (timing, 18 months of building, Plaid under-delivering, edge-case focus) VERIFIED as reported by a newsletter, secondhand: https://newsletter.failory.com/p/3-reasons-maybe-failed
- Code and community: the code stays under AGPL. README: "You're free to fork it under the AGPLv3." "Maybe" is a trademark of Maybe Finance Inc.; forks may not use the name or logo and must state they are not affiliated. VERIFIED: https://github.com/maybe-finance/maybe
- Community fork: "Sure" (`we-promise/sure`), AGPL-3.0, 16k stars, active today (last push 2026-11-17 per GitHub API), says it is "a community fork of the now-abandoned Maybe Finance project". VERIFIED: https://github.com/we-promise/sure and its API.
- Lessons (analysis): (a) a repo owned by a company dies with the company; (b) the trademark clause let the fork continue under another name, so code and name are separable; (c) 54k stars did not produce a sustainable maintainer base.

### Plausible Analytics

- Licence AGPL-3.0 or later; tracker script MIT "to avoid issues with AGPL virality". VERIFIED: https://github.com/plausible/analytics
- They moved from MIT to AGPL because permissive licensing let companies close the code and sell it. VERIFIED: https://plausible.io/blog/open-source-licenses
- Hosted vs self-host: Cloud updated several times a week; Community Edition is a long-term release published twice a year, community supported only, no premium features (funnels, ecommerce goals, SSO). VERIFIED: README above.
- Contributing: bugs in issues ("usually up for grabs"); new features must be discussed first; PRs without an issue may merge but are lower priority. No CLA mentioned. VERIFIED: https://github.com/plausible/analytics/blob/master/CONTRIBUTING.md
- Security policy: latest MAJOR.MINOR only; email and disclosure programme; no bounty. VERIFIED: https://github.com/plausible/analytics/blob/master/SECURITY.md

### Cal.com

- Repo renamed `calcom/cal.com` to `calcom/cal.diy`, relicensed AGPL-3.0 to MIT, commercial and enterprise features removed (teams, SSO, workflows, routing forms and more). Published 2026-04-15. Former interns became the official maintainers. VERIFIED: https://cal.com/blog/cal-diy-open-source-to-closed-source
- The company's stated reason for going closed was AI-driven security risk. VERIFIED only through search results (The New Stack, It's FOSS): UNVERIFIED as primary. Critics doubt the motive.
- Cal.diy README: no hosted version, "strictly recommended for personal, non-production use", contributions "do not flow to Cal.com's production platform". VERIFIED: https://github.com/calcom/cal.diy
- Contribution rules: features need a maintainer to remove the "needs approval" label; PRs under 500 lines and 10 code files; single responsibility. No CLA found. VERIFIED: https://github.com/calcom/cal.diy/blob/main/CONTRIBUTING.md
- Lesson (analysis): contributors who work on the open repo lose out when the real product moves to a private repo. Warren should run its hosted instance from the same public code, so template contributions reach users.

### Lessons for a one-maintainer MIT project (analysis, grounded above)

- Contributions are a cost before they are a gift. Actual's PRs sat for months. Set limits in writing: review not guaranteed, features need an issue first, small PRs only.
- A narrow contribution surface (bank templates) is the best protection. Plausible and Cal.diy both gate features and welcome bugs.
- Do not split into an open core and a closed hosted product. That split is what hurt Cal.com's community.
- Plan for the maintainer to leave: Maybe's code lived on because of its licence and a fork. MIT allows that. Keep docs good enough that a fork can run.
- Self-hosting must be a real, tested path, not an afterthought, or the claim "both are possible" will be tested by users.

## Q2. Name versus code

- Principle: the code licence does not license the name. Plausible states "the open source code is licensed under AGPLv3, but the trademarks are not licensed under it". VERIFIED: https://plausible.io/trademark
- Plausible policy shape. Allowed: news and fair discussion, linking to the hosted service, compatibility statements, word mark in a subdomain of a self-managed instance. Forbidden: implying endorsement, marks in your own business or product or domain names, ads, merchandise, confusing variants. Needs written permission: public hosted versions, commercial hosting or resale, modified or bundled versions. Conditions can include removing logos and stating no affiliation. VERIFIED: same URL.
- Mastodon policy shape. Sections for general use, server operators, forks and social media. Operators may use the word in a third-level or deeper domain with a visible "not affiliated" disclaimer; no top or second-level domains; forks must drop the logos and adopt distinct branding; GmbH may revoke permission at any time; requests unanswered after ten business days are deemed denied. VERIFIED: https://joinmastodon.org/trademark
- Maybe: a plain README clause, name and logo not allowed in forks, forks must state non-affiliation. VERIFIED: https://github.com/maybe-finance/maybe
- Grafana: `https://grafana.com/legal/trademark-policy/` returned 404. UNVERIFIED; I did not find the current URL.
- Minimal policy (analysis, built from the three above):
  1. Name and logo are Warren's; the MIT licence covers code only.
  2. Fair, factual references allowed.
  3. Self-hosters may say "self-hosted Warren" and may use a subdomain with a disclaimer.
  4. Forks and modified public services must use another name and logo, and say they are not affiliated.
  5. Official hosting and the logo at heywarren.app belong to the maintainer; ask for permission by email.
  6. Permission can be revoked.
- Registration: not required for a name to function as a trademark in many systems, but registration makes enforcement easier. For a solo project at launch, a written policy and consistent use give most of the value; register once there is revenue or a copycat. This is my analysis. UNVERIFIED as legal advice; ask a lawyer.
- Argentina (INPI), brief and UNVERIFIED (search snippets only, I did not open the INPI page): registration lasts 10 years and is renewable (Ley 22.362 art. 5, per a snippet); each Nice class is filed and paid separately; a news article quoted about ARS 216,000 + IVA per class, which may be outdated; approval time quoted around 24 months. I did not confirm first-to-file priority. Check https://www.argentina.gob.ar/inpi/marcas before acting.

## Q3. Security process for a repo near financial data

- SECURITY.md does not turn on reporting. GitHub shows the policy above the report form; private reporting must be enabled separately by an admin. Reporters get added as credited collaborators; a temporary private fork can host the fix; rate limits apply. VERIFIED: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability
- Actual Budget SECURITY.md. VERIFIED: https://github.com/actualbudget/actual/blob/master/SECURITY.md
  - Private report through the Security tab; no public issues.
  - Asks for version, deployment setup, reproduction steps.
  - Latest release only.
  - Publishes a threat model in plain words: for owners and trusted people; hosting for untrusted users is not supported; user roles are not a security boundary.
  - Lists out of scope: shared bank-sync credentials, malicious users with accounts, server-host control.
  - No response timeline given.
- Bitwarden. Reports through HackerOne with a PGP key; no fixed deadlines but "a reasonable amount of time"; no explicit safe harbour; bans DoS, social engineering, physical attacks; test only your own accounts. VERIFIED: https://github.com/bitwarden/server/blob/main/SECURITY.md . I did not find a bounty mention on that page.
- Mastodon. Private GitHub advisory plus security@ email; no timelines; installation-specific misconfig goes to the operator. VERIFIED: https://github.com/mastodon/mastodon/blob/main/SECURITY.md
- Plausible. Email and a disclosure programme; no bounty. VERIFIED (see Q1).
- Secret scanning is free for public repos and runs automatically; secrets of supported providers are reported to the provider; other secrets raise alerts. VERIFIED: https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- Push protection: user-level is on by default; repo-level is off by default and needs enabling by an admin; bypass by anyone with write access unless delegated bypass is set; it only blocks supported patterns. VERIFIED: https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection . Whether repo-level push protection is free for public repos was not stated on that page: check Settings.
- OpenSSF Security-Policy check scores: contact email or URL 6/10, free text 3/10, vulnerability and disclosure wording with timelines 1/10. VERIFIED: https://github.com/ossf/scorecard/blob/main/docs/checks.md
- Suggested Warren SECURITY.md (analysis): supported = latest release and the hosted instance; channel = private advisory + email; ask for version, whether hosted or self-hosted, reproduction; target an acknowledgement time you can keep (for example 5 working days, my suggestion); coordinated disclosure; good-faith safe harbour for testing only your own accounts; scope list; out of scope = operator misconfiguration, mail provider issues.
- Threat model: publish a short one (assets: ledger, mail signatures, MCP tokens, push subscriptions; actors; trust boundaries such as "a user's AI agent can only read that user's data"). Actual's is the closest example I verified. Keep it in `docs/threat-model.md` and link from SECURITY.md. No project I read publishes a longer formal model; I did not search for one. Analysis.

## Q4. Supply chain: GitHub Actions + pnpm

### Pinning actions

- GitHub says a tag "can be moved or deleted if a bad actor gains access to the repository"; pin to a full-length commit SHA, check it comes from the action repo and not a fork. The page also says a lockfile for actions "is the strongest protection available, and supersedes SHA pinning for repositories that adopt it". VERIFIED: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions . I did not read how the lockfile feature is configured: check before relying on it.
- Same page: set default `GITHUB_TOKEN` to read-only, raise per job; avoid `pull_request_target`; do not check out untrusted code in privileged triggers; every write-access user can read repo secrets. VERIFIED.
- Renovate preset `helpers:pinGitHubActionDigests` pins action digests (`pinDigests: true`). VERIFIED: https://docs.renovatebot.com/presets-helpers/

### Renovate vs Dependabot

- Renovate: reads `pnpm-workspace.yaml`, `package.json`, supports `pnpm-lock.yaml` lock file maintenance, pnpm catalogs. VERIFIED: https://docs.renovatebot.com/modules/manager/npm/
- Renovate has a `minimumReleaseAge` option (and related options); I could not read its body. VERIFIED that it exists (table of contents): https://docs.renovatebot.com/configuration-options/
- Dependabot: supports `cooldown` with `default-days`, groups, and the `github-actions` ecosystem. The cooldown table lists npm and yarn, with no pnpm entry in what I read. VERIFIED (partial; I read only the first 100k characters): https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference . Whether Dependabot handles pnpm workspaces and SHA-pinned action bumps well is UNVERIFIED.
- Recommendation reason (analysis): Renovate has verified pnpm and digest-pinning support; Dependabot's pnpm cooldown was not confirmed. Scorecard accepts either tool. VERIFIED: Scorecard doc above (Dependency-Update-Tool only checks that a tool is enabled).

### pnpm settings

VERIFIED at https://pnpm.io/settings/dependency-resolution and https://pnpm.io/settings/build :

- `minimumReleaseAge`: default 1440 (minutes, so one day). Applies to all dependencies including transitive ones. `minimumReleaseAgeExclude` exempts packages.
- `trustPolicy`: default `off`; `no-downgrade` fails install if a package's trust level dropped versus earlier releases.
- `blockExoticSubdeps`: default `true`; only root dependencies may come from git or tarball URLs.
- `strictDepBuilds`: default `true`; install exits non-zero if dependencies have unreviewed build scripts.
- `allowBuilds`: map of package matchers; unlisted packages are disallowed and treated as unreviewed.
- `ignoreScripts`: default `false`; when true it also stops your own package scripts, so it is a blunt tool.
- `dangerouslyAllowAllBuilds`: default `false`.
- Version caveat: pnpm.io shows `allowBuilds`; older docs used `onlyBuiltDependencies`, which was not on the settings index. Check which your pinned pnpm version expects.
- Also use `pnpm install --frozen-lockfile` in CI and pin `packageManager` (analysis).

### OpenSSF Scorecard

All VERIFIED from https://github.com/ossf/scorecard/blob/main/docs/checks.md :

- Critical: Dangerous-Workflow (avoid `pull_request_target`/`workflow_run` with PR checkout and untrusted `${{ github.event.* }}` in inline scripts). Meet it.
- High, worth meeting: Token-Permissions (top-level read-only), Dependency-Update-Tool (Renovate), Vulnerabilities (no open OSV issues), Binary-Artifacts, Maintained (weekly commits over 90 days scores highest).
- Medium: Pinned-Dependencies (hash pins), Security-Policy, SAST (CodeQL).
- Branch-Protection is tiered: tier 1 (no force push or deletion) works solo; tier 2 needs a reviewer.
- Code-Review: a solo maintainer who merges own commits is penalised (7 points for one unreviewed human change, 3 more for several). The page says review is "infeasible for some projects, such as those with only one active participant". Bot reviews do not count. Accept this score; do not add a fake reviewer.
- Signed-Releases and Fuzzing: low value for this app now.
- CII Best Practices badge: passing is 5, silver 7, gold 10. Optional.

### Provenance for a web app not on npm

- GitHub artifact attestations give SLSA v1.0 Build Level 2 on their own (Level 3 via reusable workflow), use Sigstore, work in public repos. VERIFIED: https://docs.github.com/en/actions/concepts/security/artifact-attestations
- Relevance (analysis): Vercel builds and serves the hosted app, so no consumer verifies a Warren artifact. Provenance matters only if you publish a Docker image or release tarball for self-hosters. Then add `actions/attest-build-provenance`, which I did not read about. npm provenance is not relevant.

## Q5. Contribution flow

### DCO vs CLA vs nothing for MIT

- DCO v1.1: contributor certifies they wrote it or may submit it under the project's open licence, and accepts the record is public. VERIFIED: https://developercertificate.org/
- None of Actual, Plausible or Cal.diy pages I read mention a CLA. Firefly DCO: UNVERIFIED (snippet). Linux kernel use of DCO is common knowledge: UNVERIFIED here.
- Analysis: MIT is inbound=outbound already, so "nothing" is legal enough, but DCO costs one `git commit -s` and gives a provenance record, which matters when the repo takes mail samples from strangers. A CLA adds friction and a signing service for a solo maintainer. Relicensing later: MIT code can be included in AGPL or proprietary works, so MIT contributions do not block a later change, but changing the project licence is exactly what hurt trust at Plausible and Cal.com. This is not legal advice.
- Fixture rule (analysis): a template PR must contain only redacted or synthetic mail, and the DCO sign-off must cover that the author may share it.

### Templates, labels, CODEOWNERS

- Cal.diy asks to fill the PR template, keep PRs under 500 lines, link issues with "Closes #123", explain testing; features wait for the "needs approval" label removal. VERIFIED: https://github.com/calcom/cal.diy/blob/main/CONTRIBUTING.md
- Actual: link issue, release-note file, remove `[WIP]`, run typecheck and lint. VERIFIED: https://actualbudget.org/docs/contributing/
- Suggested set (analysis): issue forms for "bug", "new bank template" (bank, country, redacted sample, signature type), "feature (discuss first)"; PR template with checklist (DCO, redacted fixtures, tests pass, docs); labels `template`, `bug`, `needs-discussion`, `good first issue`, `security` (redirect to private reporting), `ai-assisted`; CODEOWNERS covering `/templates`, `.github/`, auth, ledger and MCP code. With one maintainer, CODEOWNERS is for routing and future-proofing; it only blocks merges if a ruleset requires code owner review (not recommended solo).

### Branch protection for a solo maintainer

- Rulesets allow: require PR (does not need approval), required status checks (strict, loose or disabled), linear history, block force pushes, signed commits, bypass list. Zero approvals is valid. VERIFIED: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- Suggested ruleset (analysis): target `main`; require PR with 0 approvals; require checks (lint, typecheck, test, build, secret scan, DCO); linear history; block force push and deletion; no bypass list for yourself so CI is not skipped. Scorecard cost: Code-Review and Branch-Protection tier 2 lost (see Q4).

### Conventional commits, changelog, release

- Conventional Commits: `fix` = PATCH, `feat` = MINOR, `!` or `BREAKING CHANGE` = MAJOR; `docs`, `chore`, `refactor` do not change the version. VERIFIED: https://www.conventionalcommits.org/en/v1.0.0/
- release-please: parses Conventional Commits, opens a release PR, merging it tags and creates a GitHub Release with changelog; `node` and `simple` release types; manifest config for monorepos. VERIFIED: https://github.com/googleapis/release-please
- Changesets: aimed at versioning and publishing packages, monorepo focus. Its README says nothing on private apps. VERIFIED: https://github.com/changesets/changesets
- Recommendation reason (analysis): contributors need not learn an extra file per PR; squash merges with a linted PR title give one commit per change. For a hosted app, "release" is mostly a changelog and a tag for self-hosters. Actual uses a release-note file per PR (VERIFIED, Q1), which is a third option and costs contributors a step.
- Only the `warren` root or the web app needs a version; internal packages stay `private` and unversioned (analysis).

## Could not confirm

- Actual Budget CLA or DCO, governance page, "How to Cut a Release", and AI Usage Policy body (pages 404 or not read).
- Firefly III contributing rules, including the DCO and AI claims (docs.firefly-iii.org returned 403).
- Plausible and Cal.com CLA status beyond "not mentioned on pages read". Cal.com's pre-2026 contribution terms.
- Why Cal.com really went closed: only secondary reporting and company claims. Founder's own account of Maybe's dissolution and the asset-sale page (Notion) not read.
- Details of Actual's handover from its creator.
- Grafana's trademark policy (URL 404).
- Whether repo-level push protection and Renovate/Dependabot specifics (Renovate `minimumReleaseAge` body, Dependabot pnpm cooldown and SHA-pin updates) work as assumed.
- GitHub's Actions lockfile feature: setup not read.
- `actions/attest-build-provenance` usage not read.
- Argentina INPI: official INPI pages not opened; first-to-file priority, current fees and timing unconfirmed.
- Whether a trademark is needed early: my judgement, not legal advice.
- Bitwarden bounty terms and its public security whitepaper or threat model (only SECURITY.md read).
