# Security policy

Warren stores bank-mail data and a financial ledger, so security reports matter.

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub's advisory form:
**Security tab, then "Report a vulnerability"** on this repository. Only the maintainer and
you can see the report. If the form is unavailable, open an issue that says only that you have
a security report, with no details, and the maintainer will arrange a private channel.

Please include: the version or commit, whether you used the hosted instance or your own,
the steps to reproduce, and what you could read or change.

## What to expect

- Acknowledgement within 5 working days (a target, from one maintainer).
- Coordinated disclosure: please give a reasonable time to fix before publishing. You will be
  credited in the advisory unless you prefer not to be.

## Scope

In scope: this repository's code and the hosted instance. Test only your own accounts and
data, do not run denial-of-service or social-engineering attacks, and stop when you reach
another person's data.

Out of scope: a self-hosted deployment's own configuration (the operator is responsible for
it), issues in mail, hosting or database providers themselves, and findings that need a
compromised device or account.

## Supported versions

The latest release and the hosted instance.

## Threat model in short

Assets are the ledger, mail signatures and raw mail, agent tokens and push subscriptions.
A user's agent can read only that user's data. Raw mail and transfer memos never reach a
model. Records are append-only, so tampering is detectable through the hash chain.
