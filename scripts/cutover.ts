/**
 * The cutover from v1 to the rebuild, as a script. Each step is logged (to the terminal and to a file in the work directory,
 * never with a URL or a secret in it). The commands, in order, with what each prints, are in docs/runbook-cutover.md.
 *
 *   tsx scripts/cutover.ts --dry-run                  every step against a throwaway copy; changes nothing in production
 *   tsx scripts/cutover.ts                            the real thing (production)
 *   tsx scripts/cutover.ts rollback                   the old database again and the tag `v1-final` deployed
 *   tsx scripts/cutover.ts rollback --dry-run         the commands it would run
 *   tsx scripts/cutover.ts rollback --rehearse        the same two legs on STAGING (v1-final on a scratch database, then this
 *                                                     checkout again), which is how the rollback's command path is proven
 *
 * The steps (docs/rebuild-spec.md section 7, with the old service stopped first so no write is lost):
 *   1. `railway config plan` for production: abort on anything it would destroy.
 *   2. Stop the old service (`railway down`) and check it no longer answers. A sleeping service wakes on a webhook, so
 *      sleeping is not enough. Meta retries a webhook that gets no answer, so a message sent meanwhile arrives after.
 *   3. `pg_dump` the old database (kept, with the old database itself, for the rollback).
 *   4. `CREATE DATABASE warren_v2` inside the existing Postgres service (so `.railway/railway.ts` is unchanged and the
 *      rollback is only the old URL), then the migrations.
 *   5. import-v1: the old database is read in one REPEATABLE READ READ ONLY transaction.
 *   6. Verify: counts, sums, what every movement and live reminder says (md5 per account), auth tables.
 *   7. Re-check that the old database has not changed since the import read, and plan again. Abort if so.
 *   8. Switch `DATABASE_URL`, apply the config (draining and overlap) and deploy this checkout.
 *   9. `pnpm probe production --expect <the new deployment>`: it polls until `/health` names that deployment.
 *
 * Writes to the new database after the cutover are NOT carried back by a rollback: the rollback returns to the old database
 * as it was at step 2. A failure before step 8 leaves the old service stopped: run `rollback`, which deploys v1-final again.
 *
 * `--dry-run` runs 3 to 7 on a throwaway Docker Postgres holding a restored copy of the dump (read from production: a read
 * only; `--dump <file>` reuses one), and only reads for 1, 2, 8 and 9: it prints what it would run, and probes production
 * as it is with `--expect v1` (which proves the probe tells v1 from the rebuild).
 *
 * Passwords never go on a command line: `pg_dump` takes them from the `PG*` variables of its environment, and the import
 * connects in this process.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, migrate, schemaDir } from '../src/core/db'
import { changedSince, importV1, mismatches, type Snapshot, verifyV1 } from './import-v1'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const rollback = args[0] === 'rollback'
const dry = flag('dry-run')
const rehearse = flag('rehearse')
const work = opt('workdir') ?? join(tmpdir(), `warren-cutover-${Date.now()}`)
mkdirSync(work, { recursive: true })
const logFile = join(work, 'cutover.log')
const NEW_DB = opt('new-db') ?? 'warren_v2'
const WEBHOOK = 'https://wa.heywarren.app'

const clean = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/g, '<url>')
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${clean(msg)}`
  console.log(line)
  appendFileSync(logFile, `${line}\n`)
}

/** The Railway CLI. A failure keeps its stderr (without any URL), so it is never a silent `ignore`. */
const railway = (a: string[], o: { input?: string } = {}) => {
  const r = spawnSync('railway', a, { encoding: 'utf8', input: o.input, maxBuffer: 1 << 26 })
  if (r.status !== 0)
    throw new Error(
      `railway ${a.slice(0, 2).join(' ')} failed (exit ${r.status}): ${clean(`${r.stderr}${r.stdout}`).trim().slice(-1500)}`,
    )
  return r.stdout
}
const vars = (service: string, env: string): Record<string, string> =>
  JSON.parse(railway(['variables', '-s', service, '-e', env, '--json']))

/** The Postgres service's connection settings, never printed. */
function pg(env: string) {
  const v = vars('Postgres', env)
  const auth = `${encodeURIComponent(v.PGUSER ?? '')}:${encodeURIComponent(v.POSTGRES_PASSWORD ?? '')}`
  return {
    defaultDb: v.PGDATABASE ?? 'railway',
    /** Through the TCP proxy (this machine) or the private network (the app). */
    url: (db: string, where: 'public' | 'private') =>
      where === 'public'
        ? `postgresql://${auth}@${v.RAILWAY_TCP_PROXY_DOMAIN}:${v.RAILWAY_TCP_PROXY_PORT}/${db}`
        : `postgresql://${auth}@${v.PGHOST}:${v.PGPORT}/${db}`,
    /** What `pg_dump` reads: the connection in its environment, not on its command line. */
    dumpEnv: {
      PGHOST: v.RAILWAY_TCP_PROXY_DOMAIN ?? '',
      PGPORT: v.RAILWAY_TCP_PROXY_PORT ?? '',
      PGUSER: v.PGUSER ?? '',
      PGPASSWORD: v.POSTGRES_PASSWORD ?? '',
      PGDATABASE: v.PGDATABASE ?? 'railway',
    },
  }
}

/** `pg_dump`, through Docker when the machine has none (the same major version as Railway's Postgres). */
function pgDump(dumpEnv: Record<string, string>, file: string) {
  const env = { ...process.env, ...dumpEnv }
  const local = spawnSync('pg_dump', ['--version'])
  const out =
    local.status === 0
      ? execFileSync('pg_dump', ['--no-owner', '--no-acl'], { env, maxBuffer: 1 << 30 })
      : execFileSync(
          'docker',
          [
            'run',
            '--rm',
            ...Object.keys(dumpEnv).flatMap((k) => ['-e', k]),
            'postgres:18',
            'pg_dump',
            '--no-owner',
            '--no-acl',
          ],
          { env, maxBuffer: 1 << 30 },
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
    log(`step ${n}: FAILED - ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

/** `railway config plan` for production. Anything it would destroy aborts: an apply refuses it anyway, but only after the switch. */
function planCheck(env = 'production'): string {
  const r = spawnSync('railway', ['config', 'plan', '--environment', env, '--detailed-exit-code'], {
    encoding: 'utf8',
  })
  const out = `${r.stdout}${r.stderr}`
  // Exit 0: nothing pending. 2: changes pending. Anything else is an error.
  if (r.status !== 0 && r.status !== 2)
    throw new Error(`railway config plan failed: ${clean(out).slice(-800)}`)
  const summary = /Plan: (\d+) to add, (\d+) to change, (\d+) to destroy/.exec(out)
  const destroy = Number(summary?.[3] ?? 0)
  if (destroy > 0) throw new Error(`the plan would destroy ${destroy} resource(s):\n${out}`)
  if (r.status === 2 && !summary)
    throw new Error(`the plan has changes but no summary line:\n${out}`)
  const changes = out
    .split('\n')
    .filter((l) => /^\s*[~+-] /.test(l))
    .map((l) => l.trim())
  return `${summary ? summary[0] : 'up to date'}${changes.length ? ` (${changes.join('; ')})` : ''}`
}

const newest = (service: string, env: string) => {
  const list = JSON.parse(railway(['deployment', 'list', '-s', service, '-e', env, '--json'])) as {
    id: string
    status: string
  }[]
  const d = list[0]
  if (!d) throw new Error(`no deployment of ${service} in ${env}`)
  return d
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Stops the old deployment and proves it: the newest deployment is no longer running and the public health check does not answer. */
async function stopOld(env: string, healthUrl: string) {
  railway(['down', '-s', 'warren', '-e', env, '--yes'])
  for (let i = 0; i < 40; i++) {
    const d = newest('warren', env)
    const answers = await fetch(`${healthUrl}/health`).then(
      (r) => r.status === 200,
      () => false,
    )
    if (d.status !== 'SUCCESS' && !answers)
      return `deployment ${d.id.slice(0, 8)} is ${d.status}; /health does not answer`
    await sleep(3000)
  }
  throw new Error('the old service still answers after `railway down`')
}

/** The read-only probe, waiting for the deployment (or `v1`) it is told to expect. */
function probe(expect: string, env = 'production', webhookUrl?: string) {
  const r = spawnSync('pnpm', ['probe', 'production', '--expect', expect], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_ENVIRONMENT: env,
      ...(webhookUrl ? { PROBE_WEBHOOK_URL: webhookUrl, PROBE_PUBLIC_URL: webhookUrl } : {}),
    },
  })
  for (const l of (r.stdout ?? '').split('\n').filter(Boolean)) log(`  ${l}`)
  if (r.status !== 0) throw new Error(`the probe failed (expected ${expect.slice(0, 12)})`)
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
        await sleep(500)
      }
      throw new Error('the scratch Postgres did not start')
    },
    stop: () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }),
  }
}

async function cutover() {
  const dumpFile = opt('dump') ?? join(work, 'old.sql')
  const sc = dry ? scratch() : undefined
  const prod = dry && existsSync(dumpFile) ? undefined : pg('production')
  try {
    await step('1/9', 'railway config plan (abort on any destroy)', async () => planCheck())

    await step('2/9', 'stop the old service and check it is stopped', async () => {
      if (dry)
        return 'dry run: would run `railway down -s warren -e production --yes`; production keeps running'
      return stopOld('production', WEBHOOK)
    })

    await step('3/9', 'pg_dump the old database', async () => {
      if (!existsSync(dumpFile) && prod) pgDump(prod.dumpEnv, dumpFile)
      return `${Math.round(readFileSync(dumpFile).length / 1024)} KB in ${dumpFile}`
    })

    let from = ''
    let to = ''
    let appUrl = ''
    if (sc) {
      await sc.ready()
      sc.psql('postgres', 'CREATE DATABASE old')
      sc.psql('old', '', readFileSync(dumpFile, 'utf8'))
      from = sc.url('old')
      to = sc.url(NEW_DB)
    } else if (prod) {
      from = prod.url(prod.defaultDb, 'public')
      to = prod.url(NEW_DB, 'public')
      appUrl = prod.url(NEW_DB, 'private')
    }
    const oldSql = connect(from, { max: 1 })
    try {
      await step(
        '4/9',
        `create the database ${NEW_DB} inside the existing Postgres and run the migrations`,
        async () => {
          await oldSql.unsafe(`CREATE DATABASE "${NEW_DB}"`)
          const fresh = connect(to, { max: 1 })
          try {
            await migrate(fresh, schemaDir)
          } finally {
            await fresh.end({ timeout: 2 })
          }
          return dry ? 'on the scratch copy' : undefined
        },
      )

      const newSql = connect(to, { max: 1 })
      try {
        let snapshot: Snapshot = {}
        await step(
          '5/9',
          'import-v1 (the old database read in one read-only transaction)',
          async () => {
            const s = await importV1(oldSql, newSql)
            snapshot = s.snapshot
            return `${s.accounts} accounts, ${s.movements} movements, ${s.facts} facts, ${s.reminders} reminders, ${s.waMessages} wa messages`
          },
        )
        await step('6/9', 'verify', async () => {
          const checks = await verifyV1(oldSql, newSql)
          for (const c of checks) log(`  ${c.from === c.to ? 'ok  ' : 'FAIL'} ${c.name}`)
          const bad = mismatches(checks)
          if (bad.length)
            throw new Error(
              `${bad.length} of ${checks.length} verification checks differ; nothing was switched`,
            )
          return `${checks.length} checks match`
        })
        await step(
          '7/9',
          'the old database has not changed since the import read; plan again',
          async () => {
            const changed = await changedSince(oldSql, snapshot)
            if (changed.length)
              throw new Error(
                `the old database changed after the import read (${changed.join(', ')}): nothing was switched`,
              )
            return `unchanged; ${planCheck()}`
          },
        )
      } finally {
        await newSql.end({ timeout: 2 })
      }
    } finally {
      await oldSql.end({ timeout: 2 })
    }

    let expectId = 'v1'
    await step(
      '8/9',
      'point DATABASE_URL at the new database, apply the config, deploy this checkout',
      async () => {
        const commands = [
          `railway variable set DATABASE_URL --stdin -s warren -e production --skip-deploys   (the private URL of ${NEW_DB}, on stdin)`,
          'railway config apply --environment production --yes   (draining and overlap; no --confirm-destructive)',
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
        expectId = newest('warren', 'production').id
        return `deployment ${expectId.slice(0, 8)}`
      },
    )

    await step(
      '9/9',
      `production probe, expecting ${dry ? 'v1 (a dry run changes nothing)' : 'the new deployment'}`,
      async () => {
        probe(expectId)
        return 'production probe passed'
      },
    )
    log(
      dry
        ? 'dry run complete: nothing in production was changed'
        : 'cutover complete. Next: Ticiano sends one WhatsApp message and one Claude message.',
    )
  } catch (err) {
    if (!dry)
      log(
        'the cutover stopped. If step 2 ran, the old service is down: run `tsx scripts/cutover.ts rollback`.',
      )
    throw err
  } finally {
    sc?.stop()
  }
}

/** Deploys the tag `v1-final`, from a clean checkout of it, run from the linked checkout (Railway has no link for a temp directory). */
function deployV1(env: string) {
  const tag = execFileSync('git', ['rev-parse', '--verify', 'v1-final^{commit}'], {
    encoding: 'utf8',
  }).trim()
  const tree = join(work, 'v1-final')
  if (dry) {
    log(`  would run: git worktree add --detach <tree> ${tag.slice(0, 7)}`)
    log(
      `  would run: railway up <tree> --path-as-root -s warren -e ${env} --ci   (from this linked checkout)`,
    )
    return tag
  }
  execFileSync('git', ['worktree', 'add', '--detach', tree, tag], { stdio: 'pipe' })
  try {
    railway(['up', tree, '--path-as-root', '-s', 'warren', '-e', env, '--ci'])
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', tree], { stdio: 'ignore' })
  }
  return tag
}

async function rollbackToV1() {
  const env = rehearse ? 'staging' : 'production'
  const webhook = rehearse
    ? (vars('warren', 'staging').PUBLIC_URL ?? '').replace(/\/$/, '')
    : WEBHOOK
  const rehearsalDb = 'v1_rehearsal'
  const stagingPg = rehearse && !dry ? pg('staging') : undefined
  const adminUrl = stagingPg?.url(stagingPg.defaultDb, 'public') ?? ''
  const withAdmin = async (sql: string) => {
    const admin = connect(adminUrl, { max: 1 })
    try {
      await admin.unsafe(sql)
    } finally {
      await admin.end({ timeout: 2 })
    }
  }

  await step('rollback 1/3', 'point DATABASE_URL back to the old database', async () => {
    if (dry)
      return `dry run: would set DATABASE_URL on ${env} to \${{Postgres.DATABASE_URL}} (the old database is kept untouched)`
    if (stagingPg) {
      await withAdmin(`DROP DATABASE IF EXISTS "${rehearsalDb}" WITH (FORCE)`)
      await withAdmin(`CREATE DATABASE "${rehearsalDb}"`)
    }
    railway(
      ['variable', 'set', 'DATABASE_URL', '--stdin', '-s', 'warren', '-e', env, '--skip-deploys'],
      {
        input: stagingPg ? stagingPg.url(rehearsalDb, 'private') : '${{Postgres.DATABASE_URL}}',
      },
    )
    return stagingPg ? `staging: a scratch database ${rehearsalDb}` : undefined
  })
  await step('rollback 2/3', 'deploy the tag v1-final and probe it', async () => {
    const tag = deployV1(env)
    if (dry) return 'dry run'
    probe('v1', env, webhook)
    return `${tag.slice(0, 7)} answers (no build header)`
  })
  if (rehearse && !dry) {
    // The way back is the cutover's own deploy: this checkout with `railway up`, then the probe waiting for that deployment.
    await step(
      'rollback 3/3',
      'rehearsal only: this checkout again on the staging database',
      async () => {
        railway(
          [
            'variable',
            'set',
            'DATABASE_URL',
            '--stdin',
            '-s',
            'warren',
            '-e',
            'staging',
            '--skip-deploys',
          ],
          {
            input: '${{Postgres.DATABASE_URL}}',
          },
        )
        railway(['up', '-s', 'warren', '-e', 'staging', '--ci'])
        const id = newest('warren', 'staging').id
        probe(id, 'staging', webhook)
        await withAdmin(`DROP DATABASE IF EXISTS "${rehearsalDb}" WITH (FORCE)`)
        return `deployment ${id.slice(0, 8)} answers`
      },
    )
  }
  log(
    dry
      ? 'rollback dry run complete: nothing was changed'
      : 'rolled back: run `pnpm probe production --expect v1`',
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  log(
    `${rollback ? 'rollback' : 'cutover'}${dry ? ' (dry run)' : ''}${rehearse ? ' (rehearsal on staging)' : ''}; log in ${logFile}`,
  )
  try {
    await (rollback ? rollbackToV1() : cutover())
  } catch {
    failed = true
  }
  if (dry && !failed) rmSync(join(work, 'old.sql'), { force: true })
  process.exit(failed ? 1 : 0)
}
