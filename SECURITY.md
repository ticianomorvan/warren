# Security policy

Warren is an MCP server: people's own agents log movements and facts in it, and people sign in
with Google. Warren runs no model and sends nothing to any AI provider. It stores the movements
and facts an agent sends, and who signed in. Security reports matter.

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub's advisory form:
**Security tab, then "Report a vulnerability"** on this repository. Only the maintainer and
you can see the report. If the form is unavailable, open an issue that says only that you have
a security report, with no details, and the maintainer will arrange a private channel.

Please include: the version or commit, the steps to reproduce, and what you could read or
change.

## What to expect

- Acknowledgement within 5 working days (a target, from one maintainer).
- Coordinated disclosure: please give a reasonable time to fix before publishing. You will be
  credited in the advisory unless you prefer not to be.

## Scope

In scope: this repository's code and the hosted service. Test only your own account and
data, do not run denial-of-service or social-engineering attacks, and stop when you reach
another person's data.

Out of scope: issues in Google, an MCP client, hosting or database providers themselves, a
self-hosted deployment's own configuration, a person's own agent writing a wrong but valid row,
and findings that need a compromised device or account.

## Supported versions

The latest commit on `main` and the hosted service.

## Threat model in short

Assets are people's movements and facts; the auth secret and keys behind MCP access tokens; the
Google OAuth client secret.

- Keys live only in the gitignored `.env` and the host's environment, never in code, logs or
  commits. Warren stores none of Google's tokens: only that a Google account signed in. What a
  client sends that looks like a secret (a card, a CBU, a password, a DNI) is stored nowhere.
- Sign-in is Google only and open to anyone; no other route can make a user. Access tokens are
  15-minute JWTs bound to the MCP URL, from any client: one that identifies with a metadata document
  (fetched only from public addresses) or registers itself (open, rate limited). A client can do
  nothing until the person signs in and consents on a page that names where it sends them back. "Disconnect all agents" on the account page revokes them.
- Every write goes through guarded tools: code checks every call, a target must be the person's
  own live record, code does all arithmetic and renders the record, so one agent cannot reach
  another person's data or invent an amount. One account is capped (live movements, calls per
  minute) so open sign-up cannot fill the database.
- Nothing is overwritten or deleted: a correction or delete is a new version, enforced by a
  database trigger, and an undo is made of the same moves. The one exception is deleting an
  account, behind a fresh sign-in, through one database function.

The rules in full are in [`AGENTS.md`](AGENTS.md), and the reasons in [`docs/design.md`](docs/design.md).
