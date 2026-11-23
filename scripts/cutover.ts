/**
 * The cutover from v1 to the rebuild, as a script R9 runs. Each step is logged (to the terminal and to a file in the work
 * directory, never with a URL or a secret in it).
 *
 *   tsx scripts/cutover.ts --dry-run                       every step, against copies; touches nothing in production
 *   tsx scripts/cutover.ts --new-url <url> [--new-app-url <url>] --old-stopped
 *                                                          the real thing. `--new-url` is a reachable URL of the new, empty
 *                                                          Postgres (the one R9 created); `--new-app-url` is what the app uses
 *                                                          (its private URL), default the same. `--old-stopped` confirms the
 *                                                          old service no longer takes writes (put it to sleep first).
 *   tsx scripts/cutover.ts rollback [--dry-run]            point back to the old database and deploy the tag `v1-final`
 *
 * The six steps, as in docs/rebuild-spec.md section 7:
 *   1. pg_dump the old database (kept; it is also what the rollback points back to).
 *   2. The new Postgres: run the migrations.
 *   3. import-v1: entities, versions and turns built from v1's live rows, the auth tables, recent wamids.
 *   4. Verify: every account, live movement count and sum per currency, live facts, live reminders with next_due_at, auth counts.
 *   5. Point DATABASE_URL of the production service at the new database, apply the Railway config and deploy.
 *   6. Production probes (`pnpm probe production`).
 *
 * `--dry-run` runs 1 to 4 and 6 on copies: the dump is read from production (a read only; skip it with `--dump <file>`), restored into
 * a throwaway Docker Postgres that also holds the "new" database, and the import and verification run there. Step 5 prints the
 * commands it would run. Step 6 is read-only by design, so it runs against production as it is now.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, migrate, schemaDir } from '../src/core/db'
import { importV1, mismatches, verifyV1 } from './import-v1'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const rollback = args[0] === 'rollback'
const dry = flag('dry-run')
const work = opt('workdir') ?? join(tmpdir(), `warren-cutover-${Date.now()}`)
mkdirSync(work, { recursive: true })
const logFile = join(work, 'cutover.log')

const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  appendFileSync(logFile, `${line}\n`)
}
const railway = (a: string[], o: { input?: string } = {}) =>
  execFileSync('railway', a, { encoding: 'utf8', input: o.input, stdio: ['pipe', 'pipe', 'pipe'] })
const productionVars = (service: string): Record<string, string> =>
  JSON.parse(railway(['variables', '-s', service, '-e', 'production', '--json']))

/** The old database's public URL, built from the Postgres service's TCP proxy and PG* variables (never printed). */
function oldUrl(): string {
  const v = productionVars('Postgres')
  return `postgresql://${v.PGUSER}:${encodeURIComponent(v.POSTGRES_PASSWORD ?? '')}@${v.RAILWAY_TCP_PROXY_DOMAIN}:${v.RAILWAY_TCP_PROXY_PORT}/${v.PGDATABASE}`
}

/** `pg_dump` through Docker when the machine has none: the same major version as Railway's Postgres. */
function pgDump(url: string, file: string) {
  const local = spawnSync('pg_dump', ['--version'])
  const out =
    local.status === 0
      ? execFileSync('pg_dump', ['--no-owner', '--no-acl', url], { maxBuffer: 1 << 30 })
      : execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '-e',
            `U=${url}`,
            'postgres:18',
            'sh',
            '-c',
            'pg_dump --no-owner --no-acl "$U"',
          ],
          { maxBuffer: 1 << 30 },
        )
  writeFileSync(file, out)
}

let failed = false
async function step(n: string, name: string, fn: () => Promise<string | undefined>) {
  log(`step ${n}: ${name}`)
  try {
    const note = await fn()
    log(`step ${n}: ok${note ? ` - ${note}` : ''}`)
  } catch (err) {
    failed = true
    log(
      `step ${n}: FAILED - ${err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>') : String(err)}`,
    )
    throw err
  }
}

/** A throwaway Postgres for the dry run: holds the restored copy of the old database and the empty new one. */
function scratch() {
  const name = `warren-cutover-dry-${process.pid}`
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=pw',
      '-p',
      `${port}:5432`,
      'postgres:17',
    ],
    { stdio: 'ignore' },
  )
  const psql = (db: string, sql: string, input?: string) =>
    execFileSync(
      'docker',
      [
        'exec',
        ...(input ? ['-i'] : []),
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        db,
        '-q',
        '-v',
        'ON_ERROR_STOP=0',
        ...(input ? [] : ['-c', sql]),
      ],
      { input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 28 },
    )
  return {
    url: (db: string) => `postgres://postgres:pw@127.0.0.1:${port}/${db}`,
    psql,
    async ready() {
      for (let i = 0; i < 60; i++) {
        if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) return
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('the scratch Postgres did not start')
    },
    stop: () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }),
  }
}

async function cutover() {
  const dumpFile = opt('dump') ?? join(work, 'old.sql')
  let from = ''
  let to = ''
  let appUrl = ''
  const sc = dry ? scratch() : undefined
  try {
    if (!dry) {
      to = opt('new-url') ?? ''
      appUrl = opt('new-app-url') ?? to
      if (!to) throw new Error('--new-url is required (or --dry-run)')
      if (!flag('old-stopped'))
        throw new Error(
          '--old-stopped is required: the old service must not take writes during the import',
        )
      from = oldUrl()
    }

    await step('1/6', 'pg_dump the old database', async () => {
      if (!existsSync(dumpFile)) pgDump(oldUrl(), dumpFile)
      return `${Math.round(readFileSync(dumpFile).length / 1024)} KB in ${dumpFile}`
    })

    if (sc) {
      await sc.ready()
      sc.psql('postgres', 'CREATE DATABASE old')
      sc.psql('postgres', 'CREATE DATABASE new')
      sc.psql('old', '', readFileSync(dumpFile, 'utf8'))
      from = sc.url('old')
      to = sc.url('new')
    }
    const oldSql = connect(from, { max: 1 })
    const newSql = connect(to, { max: 1 })
    try {
      await step('2/6', 'new Postgres: run the migrations', async () => {
        await migrate(newSql, schemaDir)
        return dry ? 'on the scratch copy' : undefined
      })
      await step('3/6', 'import-v1', async () => {
        const s = await importV1(oldSql, newSql)
        return `${s.accounts} accounts, ${s.movements} movements, ${s.facts} facts, ${s.reminders} reminders, ${s.waMessages} wa messages`
      })
      await step('4/6', 'verify', async () => {
        const checks = await verifyV1(oldSql, newSql)
        for (const c of checks) log(`  ${c.from === c.to ? 'ok  ' : 'FAIL'} ${c.name}`)
        const bad = mismatches(checks)
        if (bad.length)
          throw new Error(
            `${bad.length} of ${checks.length} verification checks differ; nothing was switched`,
          )
        return `${checks.length} checks match`
      })
    } finally {
      await oldSql.end({ timeout: 2 })
      await newSql.end({ timeout: 2 })
    }

    await step(
      '5/6',
      'point DATABASE_URL at the new database, apply the config, deploy',
      async () => {
        const commands = [
          'railway variable set DATABASE_URL --stdin -s warren -e production --skip-deploys   (the new database URL, on stdin)',
          'railway config apply --environment production --yes   (draining, overlap and the rest of .railway/railway.ts)',
          'railway up -s warren -e production --ci   (this checkout)',
        ]
        if (dry) {
          for (const c of commands) log(`  would run: ${c}`)
          return 'dry run: nothing was changed'
        }
        railway(
          [
            'variable',
            'set',
            'DATABASE_URL',
            '--stdin',
            '-s',
            'warren',
            '-e',
            'production',
            '--skip-deploys',
          ],
          { input: appUrl },
        )
        railway(['config', 'apply', '--environment', 'production', '--yes'])
        railway(['up', '-s', 'warren', '-e', 'production', '--ci'])
        return 'deployed'
      },
    )

    await step('6/6', 'production probes', async () => {
      const r = spawnSync('pnpm', ['probe', 'production'], { encoding: 'utf8' })
      for (const l of (r.stdout ?? '').split('\n').filter(Boolean)) log(`  ${l}`)
      if (r.status !== 0)
        throw new Error('the production probe failed: run `tsx scripts/cutover.ts rollback`')
      return 'production probe passed'
    })
    log(
      dry
        ? 'dry run complete: nothing in production was changed'
        : 'cutover complete. Next: Ticiano sends one WhatsApp message and one Claude message.',
    )
  } finally {
    sc?.stop()
  }
}

async function rollbackToV1() {
  const tag = execFileSync('git', ['rev-parse', '--verify', 'v1-final^{commit}'], {
    encoding: 'utf8',
  }).trim()
  await step('rollback 1/2', 'point DATABASE_URL back to the old database', async () => {
    if (dry)
      return 'dry run: would set DATABASE_URL to the old Postgres service reference ${{Postgres.DATABASE_URL}} (the old database is kept untouched)'
    railway(
      [
        'variable',
        'set',
        'DATABASE_URL',
        '--stdin',
        '-s',
        'warren',
        '-e',
        'production',
        '--skip-deploys',
      ],
      { input: '${{Postgres.DATABASE_URL}}' },
    )
    return undefined
  })
  await step('rollback 2/2', `deploy the tag v1-final (${tag.slice(0, 7)})`, async () => {
    const tree = join(work, 'v1-final')
    if (dry)
      return `dry run: would check the tag out into ${tree} and run \`railway up -s warren -e production --ci\` from it`
    execFileSync('git', ['worktree', 'add', '--detach', tree, tag], { stdio: 'ignore' })
    try {
      execFileSync('railway', ['up', '-s', 'warren', '-e', 'production', '--ci'], {
        cwd: tree,
        stdio: 'ignore',
      })
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', tree], { stdio: 'ignore' })
    }
    return 'v1-final deployed on the old database'
  })
  log(
    dry
      ? 'rollback dry run complete: nothing was changed'
      : 'rolled back: run `pnpm probe production`',
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  log(`${rollback ? 'rollback' : 'cutover'}${dry ? ' (dry run)' : ''}; log in ${logFile}`)
  try {
    await (rollback ? rollbackToV1() : cutover())
  } catch {
    failed = true
  }
  if (dry && !failed) rmSync(join(work, 'old.sql'), { force: true })
  process.exit(failed ? 1 : 0)
}
