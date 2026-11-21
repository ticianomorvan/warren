# Security policy

Warren reads expense messages people send on WhatsApp, sends them to the Anthropic API to be
parsed, and stores the resulting movements. Security reports matter.

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

Out of scope: issues in WhatsApp/Meta, Anthropic, hosting or database providers themselves, a
self-hosted deployment's own configuration, and findings that need a compromised device or
account.

## Supported versions

The latest commit on `main` and the hosted service.

## Threat model in short

Assets are people's messages and movements, the WhatsApp access token, the app secret and the
Anthropic API key. Secrets live only in the gitignored `.env` (and the host's environment), never
in code, logs or eval output. The model only parses a message into a typed command; code
validates it, does all arithmetic and writes the reply, so a message cannot make the model act.
Design rules for the slices still to build, not protections that exist today: corrections never
overwrite a movement, so history is kept (slices 3 and 4), and webhooks are accepted only with a
valid signature (slice 2). Today the repository holds the parser and its eval only.
