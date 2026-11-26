# Warren

A personal-finance ledger for Argentina that any AI agent can drive. Warren is an MCP server: you bring your own agent (Claude,
ChatGPT, Cursor, a scheduled `claude -p`), sign in with Google, and the agent logs your spending ("café 3500 con la visa"), imports a
statement or a spreadsheet, corrects and undoes, and asks for totals. Warren stores every version of every movement and computes
every total, so an agent never does the arithmetic.

Warren runs no model of its own. Its job is the tools, the rules the tools enforce and the instructions that teach any agent to use
them. To set it up, tell your agent: "set up Warren from heywarren.app". It reads `/setup.md` and connects itself; you only click
"Continuar con Google" and allow it.

- [`AGENTS.md`](AGENTS.md): the rules every change keeps, the layout, the commands and the deploy.
- [`docs/design.md`](docs/design.md): how it works and why.

Earlier products live on as tags: `v0-mail-ledger` (a ledger from bank mail) and `v1-final` (the WhatsApp agent). The WhatsApp agent and
its reminders of the rebuild are in git history before the cut to MCP-only.

## Run it

Node 24 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check                                       # lint, typecheck and tests; no network, no keys
```

Running the server (`pnpm start`) needs a Postgres (`DATABASE_URL`). With `PUBLIC_URL` it also serves the sign-in, the OAuth server,
the web and `/mcp`, and then needs `BETTER_AUTH_SECRET` and a Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`); see
`AGENTS.md`.

Licence: MIT. The name is covered by [`TRADEMARK.md`](TRADEMARK.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md).
