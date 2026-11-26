import { readFileSync } from 'node:fs'
import { connect, type Sql } from './core/db'
import { accountOfWaId, type ImportResult, importMovements } from './domain/import'

/**
 * `pnpm import:movements <file.jsonl> --wa <wa_id> [--check]`: a person's backlog into their ledger as one turn, so one "deshacer"
 * takes it all back within the undo window. One `log_movements` movement per line. `--check` validates the file and writes nothing.
 * The import becomes the newest step of the person's undo stack: run it when they are not in the middle of a conversation. Writes go
 * to DATABASE_URL (for Railway, the Postgres service public URL through its TCP proxy), which is never printed.
 */
function usage(problem: string): never {
  console.error(`${problem}\nUsage: pnpm import:movements <file.jsonl> --wa <wa_id> [--check]`)
  process.exit(1)
}

const args = process.argv.slice(2)
const file = args[0]
if (!file || file.startsWith('--')) usage('Name the file first.')
const checkOnly = args.includes('--check')
const waAt = args.indexOf('--wa')
const waId = waAt >= 0 ? (args[waAt + 1] ?? '').replace(/\D/g, '') : ''
if (!checkOnly && waId.length < 8) usage('--wa needs the WhatsApp number, digits only.')

const rows: unknown[] = []
const broken: number[] = []
readFileSync(file, 'utf8')
  .replace(/^﻿/, '')
  .split(/\r?\n/)
  .forEach((line, i) => {
    if (line.trim() === '') return
    try {
      rows.push(JSON.parse(line))
    } catch {
      broken.push(i + 1)
    }
  })
if (broken.length > 0)
  usage(`Not JSON: line ${broken.slice(0, 10).join(', ')}${broken.length > 10 ? '…' : ''}.`)
if (rows.length === 0) usage('The file has no rows.')

function report(result: ImportResult): void {
  if (result.status === 'refused') {
    for (const p of result.problems) console.error(`rows ${p.rows[0]}-${p.rows[1]}: ${p.message}`)
    console.error(`${result.problems.length} refused call(s); nothing was written.`)
    process.exitCode = 1
  } else if (result.status === 'already') {
    console.error(`These rows were already imported (turn ${result.turn}); nothing was written.`)
    process.exitCode = 1
  } else if (result.status === 'checked') {
    console.log(`${result.movements} rows pass the guards; nothing was written.`)
  } else {
    console.log(`imported ${result.movements} movements as turn ${result.turn}`)
  }
}

if (checkOnly) {
  report(await importMovements({ rows }))
} else {
  const url = process.env.DATABASE_URL
  if (!url) usage('Set DATABASE_URL.')
  const sql: Sql = connect(url, { max: 1 })
  try {
    const accountId = await accountOfWaId(sql, waId)
    if (accountId === null) {
      console.error('No account has that WhatsApp number.')
      process.exitCode = 1
    } else {
      report(await importMovements({ rows, into: { sql, accountId } }))
    }
  } finally {
    await sql.end()
  }
}
