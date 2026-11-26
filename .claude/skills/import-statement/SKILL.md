---
name: import-statement
description: Seed a person's Warren ledger from a file they give you (a bank or card statement, an export, a spreadsheet, a list). Converts it to movements, checks it against what the ledger already has, shows the person before writing, and writes it with `pnpm import:movements`. Use when asked to import, load or seed past expenses or income. The person is found by their account id or the Google email they signed in with.
---

# Import a statement into Warren

`pnpm import:movements` is the last, safe step: it runs the guards, writes one turn, refuses the exact same file twice and stops at the
account's cap of 100,000 live movements. It does not
know what a statement means, whether an amount is the real one, or what the ledger already has. Those are your job, and they are where
an import goes wrong. Never write before the person has seen the rows.

## 1. Read the source

- PDF, CSV, XLS or a Drive/Sheets file: read every row, and say how many you read. Note the account or card it belongs to.
- **Copy amounts exactly** as the source shows them ("$12.345,67" is `12345.67`). Never add, convert, round or work out a cuota
  (AGENTS.md rule 1: the program does all arithmetic). When code must sum something (for example, daily interest into one row a month),
  do it in a script with `Decimal`, never in your head.
- Spot-check at least three rows, the largest among them, against the source itself and say which.

## 2. Decide what counts, and ask

Ask the person when a choice changes their totals; do not decide alone. The usual ones:

- **Leave out**: payments of a card's statement (the purchases are already counted), transfers between their own accounts, voided
  or declined charges, holds that never became charges.
- **Cuotas**: one row per cuota on the statement where it was charged, or the whole purchase on its day. Never a date after today:
  the guards refuse it.
- **Credits** (refunds, tax perceptions given back, cashback): income, `otros_ingresos`, with a positive amount.
- **Currencies**: only `ARS` and `USD`. USDT and USDC count as `USD`. Anything else (BTC, ETH) stays out unless the person says how.

## 3. Write the rows

One JSON object per line (JSON Lines), the `log_movements` movement of `src/core/commands.ts`:

```text
{"direction":"out","amount":"12345.67","currency":"ARS","date":"2026-11-03","description":"Punto Guemes","category":"otros","payment":"BBVA Visa crédito","confidence":"high"}
```

- `direction` `out` (spending) or `in` (income). `amount` a positive decimal string, at most 2 decimals, no thousands separator.
  `date` `yyyy-mm-dd`, Argentine day, not after today.
- `category`, one of: `supermercado`, `restaurantes`, `transporte`, `combustible`, `vivienda`, `servicios`, `salud`, `educacion`,
  `entretenimiento`, `ropa`, `regalos`, `mascotas`, `viajes`, `impuestos`, `transferencias`, `sueldo`, `otros_ingresos`, `otros`.
  Reuse what the ledger already gave the same merchant (`warren_find_movements` with the merchant's words).
- `description` and `payment`: a few words, **no number of 4 or more digits** (the guards refuse it, and AGENTS.md rule 5 keeps
  card, account and CBU numbers out). Strip operation codes and card endings ("BBVA Visa crédito", not "Visa *1774").
- Keep the file and any conversion script outside the repository (the scratchpad): it is the person's data.

## 4. Check against the ledger

The importer does not see overlap between different files. Before writing, look at what Warren already has for the same dates
(`warren_find_movements` with `from`/`to`, or `warren_summarize` grouped by day) and:

- drop rows already there (same day and amount from the same account), and say how many;
- for a card statement after movements already logged from mail notices or chats: match each purchase, correct a hold to its real charge
  (`warren_correct_movement`) rather than adding a second row, and list what you could not match.

## 5. Show, then write

1. `pnpm import:movements <file.jsonl> --check`. It writes nothing; fix every refused row it names.
2. Show the person the row count, the totals by month and currency (computed by a script from the file), what you left out and why,
   and every row you were unsure of. Give them the file's path. Wait for their OK.
3. Write to production. Build `DATABASE_URL` from the Railway CLI without printing it (the `Postgres` service's `DATABASE_URL` with
   its host and port replaced by `RAILWAY_TCP_PROXY_DOMAIN` and `RAILWAY_TCP_PROXY_PORT`), and name the person by the Google email
   they signed in with, or by their account id (`SELECT warren_account_id FROM auth_user WHERE email = '...'`):
   `pnpm import:movements <file.jsonl> --email <google email>` or `--account <id>`. It prints the turn. The person must have signed
   in with Google at least once: that is what makes their account.
4. Prove it: `warren_summarize` for two months must match the totals you showed, and its counts must add up to the rows written.

Tell the person that one `warren_undo_last` (from any agent) takes the whole import back, within 24 hours of the import, and that the
import is now their newest change, so the next undo takes it back, not what they did before.
