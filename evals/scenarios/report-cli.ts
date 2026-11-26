import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RunSummary, renderLatest } from './report'

/**
 * `pnpm eval:report [result.json ...]`: writes `results/latest.md` from run files (by default the three
 * newest `*-all.json` in `results/`).
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), 'results')

const positionals = process.argv.slice(2)

const load = (file: string): RunSummary => {
  const { startedAt, model, summary } = JSON.parse(readFileSync(file, 'utf8'))
  return { startedAt, model, summary }
}

const files =
  positionals.length > 0
    ? positionals
    : readdirSync(dir)
        .filter((f) => f.endsWith('-all.json'))
        .sort()
        .slice(-3)
        .map((f) => join(dir, f))
if (files.length === 0)
  throw new Error('no result files: run pnpm eval:scenarios --split all first')

const runs = files.map(load)
writeFileSync(join(dir, 'latest.md'), `${renderLatest(runs)}\n`)
console.log(`wrote results/latest.md from ${files.length} run file(s)`)
