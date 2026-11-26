# Security policy

Warren reads the messages people send it on WhatsApp or through an MCP client, sends them to the
Anthropic API to be understood (voice notes go to OpenRouter to be transcribed), and stores the
resulting movements, facts and reminders. Security reports matter.

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

Assets are people's messages, movements, facts and reminders; the WhatsApp access token and app
secret; the Anthropic and OpenRouter keys; and the auth secret and keys behind MCP access tokens.

- Keys live only in the gitignored `.env` and the host's environment, never in code, logs or eval
  output. A message that looks like a secret (a card, a CBU, a password, a DNI) is stored nowhere.
- A webhook is accepted only with a valid Meta signature, and only allowed senders get a reply.
- The model acts only through guarded tools. Code checks every call, may only target a record the
  person was shown and owns, does all arithmetic and writes the reply, so a message cannot make the
  model reach another person's data or invent an amount.
- Nothing is overwritten or deleted: a correction or delete is a new version, enforced by a
  database trigger, and an undo is made of the same moves.
- MCP clients sign in through a code the person confirms on WhatsApp. Tokens are short-lived JWTs
  bound to the MCP URL, and "desconectar" on WhatsApp revokes them.

The rules in full are in [`AGENTS.md`](AGENTS.md), and the reasons in [`docs/design.md`](docs/design.md).
