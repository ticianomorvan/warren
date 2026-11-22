import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type RunSummary, renderLatest } from './report'

/**
 * `pnpm eval:report [--as-baseline] [result.json ...]`: writes `results/latest.md` from run files (by
 * default the three newest `*-all.json` in `results/`). The committed `results/v1-baseline.json` holds
 * the v1 runs' summaries; `--as-baseline` rewrites it from the given files instead of reading it.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), 'results')
const baselineFile = join(dir, 'v1-baseline.json')

const { values, positionals } = parseArgs({
  options: { 'as-baseline': { type: 'boolean', default: false } },
  allowPositionals: true,
})

const load = (file: string): RunSummary => {
  const { startedAt, model, summary } = JSON.parse(readFileSync(file, 'utf8'))
  return { startedAt, model, summary }
}

const files =
  positionals.length > 0
    ? positionals
    : readdirSync(dir)
        .filter((f) => f.endsWith('-all.json') && f !== 'v1-baseline.json')
        .sort()
        .slice(-3)
        .map((f) => join(dir, f))
if (files.length === 0)
  throw new Error('no result files: run pnpm eval:scenarios --split all first')

const runs = files.map(load)
if (values['as-baseline']) writeFileSync(baselineFile, `${JSON.stringify(runs, null, 2)}\n`)
const baseline: RunSummary[] = JSON.parse(readFileSync(baselineFile, 'utf8'))
writeFileSync(join(dir, 'latest.md'), `${renderLatest(runs, baseline)}\n`)
console.log(`wrote results/latest.md from ${files.length} run file(s)`)
