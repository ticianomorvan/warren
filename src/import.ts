import { readFileSync } from 'node:fs'
import { connect } from './core/db'
import { accountOfWaId, checkRows, importMovements, type Problem } from './domain/import'
import { argentinaToday } from './time'

/**
 * `pnpm import:movements <file.jsonl> --wa <wa_id> [--check]`: a person's backlog (a spreadsheet, old statements) into their ledger as
 * one turn, so one "deshacer" takes it all back within the undo window. One `log_movements` movement per line. `--check` validates the
 * file and writes nothing. Writes go to DATABASE_URL (for Railway, the Postgres service public URL), which is never printed.
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const file = args[0]
const waId = flag('--wa')
const checkOnly = args.includes('--check')
if (!file || file.startsWith('--') || (!checkOnly && !waId)) {
  console.error('Usage: pnpm import:movements <file.jsonl> --wa <wa_id> [--check]')
  process.exit(1)
}

const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l, i) => {
    try {
      return JSON.parse(l) as unknown
    } catch {
      console.error(`line ${i + 1} is not JSON`)
      return process.exit(1)
    }
  })

const report = (problems: Problem[]) => {
  for (const p of problems) console.error(`rows ${p.rows[0]}-${p.rows[1]}: ${p.message}`)
  console.error(`${problems.length} refused call(s); nothing was written.`)
  process.exitCode = 1
}

if (checkOnly) {
  const now = new Date()
  const { problems } = checkRows(rows, { today: argentinaToday(now), now })
  if (problems.length > 0) report(problems)
  else console.log(`${rows.length} rows pass the guards; nothing was written.`)
  process.exit()
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (for Railway, the Postgres service public URL).')
  process.exit(1)
}
const sql = connect(url, { max: 1 })
try {
  const accountId = await accountOfWaId(sql, String(waId).replace(/\D/g, ''))
  if (accountId === null) {
    console.error('No account has that WhatsApp number.')
    process.exitCode = 1
  } else {
    const result = await importMovements(sql, { accountId, rows })
    if (result.status === 'refused') report(result.problems)
    else console.log(`imported ${result.movements} movements as turn ${result.turn}`)
  }
} finally {
  await sql.end()
}
