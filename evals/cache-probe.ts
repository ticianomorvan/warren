/**
 * Prompt-cache probe: what a cache miss costs in time and money, against the real API.
 *
 *   pnpm tsx evals/cache-probe.ts pairs [--n 10] [--ttl 5m|1h]
 *       Each pair is a cold call (a fresh nonce in front of the frozen system prompt, so the prefix has
 *       never been seen: the whole prefix is written) and then the same request again, warm (the prefix
 *       is read). Streaming, to split the time to the first token from the rest.
 *   pnpm tsx evals/cache-probe.ts strict [--n 10]
 *       The same warm request with strict tools (the old production setting) and without (the current one),
 *       interleaved, for a one-word message and a log: the time `strict: true` adds to a call.
 *   pnpm tsx evals/cache-probe.ts gap [--wait 330]
 *       The sparse-message case: write the prefix with each TTL, wait, send the same request again.
 *       5m is expected to miss after 5 minutes and 1h to hit.
 *
 * It spends money (about US$0.003 per pair) and prints no secret. The request is the production one
 * (`requestBase`: model, effort, thinking, strict tools); only the system prompt's first line and its TTL differ.
 */
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { type ContextInput, estimateCostUsd, renderContext, SYSTEM_PROMPT } from '../src/agent'
import { CACHE_TTL, requestBase } from '../src/agent/loop'
import { keepAliveFetch } from '../src/http'
import type { MovementRow } from '../src/ledger'
import { argentinaTime } from '../src/time'

try {
  process.loadEnvFile(new URL('../.env', import.meta.url))
} catch {}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing: set it in .env')

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: 'string', default: '10' },
    ttl: { type: 'string', default: '5m' },
    wait: { type: 'string', default: '330' },
  },
})
const client = new Anthropic({ fetch: keepAliveFetch() })

const today = '2026-11-21'
const movement = (id: number, description: string, amount: string, category: string): MovementRow =>
  ({
    id,
    direction: 'out',
    amount,
    currency: 'ARS',
    date: today,
    time: '10:00',
    description,
    category,
    payment: null,
  }) as MovementRow
const context: ContextInput = {
  text: 'cafe 3500',
  today,
  time: argentinaTime(new Date(`${today}T15:00:00Z`)),
  movements: [
    movement(110, 'súper', '12000', 'supermercado'),
    movement(109, 'café', '2900', 'restaurantes'),
    movement(108, 'nafta', '20000', 'combustible'),
    movement(107, 'taxi', '5400', 'transporte'),
  ],
  conversation: [],
  pending: null,
}
const message = renderContext(context)

interface Run {
  ms: number
  /** Until the first content event (the first token of the answer). */
  firstMs: number
  output: number
  read: number
  write5m: number
  write1h: number
  costUsd: number
}

async function call(nonce: string, ttl: '5m' | '1h'): Promise<Run> {
  const base = requestBase('haiku')
  const started = performance.now()
  const stream = client.messages.stream({
    ...base,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: `[probe ${nonce}]\n${SYSTEM_PROMPT}`,
        cache_control: { type: 'ephemeral', ttl },
      },
    ],
    messages: [{ role: 'user', content: message }],
  })
  let firstMs = 0
  for await (const event of stream) {
    if (!firstMs && event.type === 'content_block_start') firstMs = performance.now() - started
  }
  const final = await stream.finalMessage()
  const ms = performance.now() - started
  const u = final.usage
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  return {
    ms,
    firstMs,
    output: u.output_tokens,
    read: u.cache_read_input_tokens ?? 0,
    write5m,
    write1h,
    costUsd: estimateCostUsd('haiku', {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: write5m + write1h,
      cacheWrite1hTokens: write1h,
    }),
  }
}

const stat = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] as number
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const line = (name: string, runs: Run[], f: (r: Run) => number, unit = 'ms') =>
  console.log(
    `  ${name.padEnd(26)} p50 ${stat(runs.map(f), 50).toFixed(0).padStart(6)} ${unit}   p95 ${stat(runs.map(f), 95).toFixed(0).padStart(6)} ${unit}   mean ${mean(runs.map(f)).toFixed(0).padStart(6)} ${unit}`,
  )

async function pairs() {
  const n = Number(values.n)
  const ttl = values.ttl as '5m' | '1h'
  const cold: Run[] = []
  const warm: Run[] = []
  // The tool grammar is compiled on the first request after the schema changes: do not count that one.
  await call('warmup', ttl)
  for (let k = 0; k < n; k++) {
    const nonce = `${Date.now()}-${k}-${Math.random().toString(36).slice(2)}`
    cold.push(await call(nonce, ttl))
    warm.push(await call(nonce, ttl))
  }
  console.log(`\nTTL ${ttl}, ${n} pairs, claude-haiku-5-5, the production request\n`)
  for (const [name, runs] of [
    ['COLD (prefix written)', cold],
    ['WARM (prefix read)', warm],
  ] as const) {
    console.log(
      `${name}: cache read ${mean(runs.map((r) => r.read)).toFixed(0)} tok, written 5m ${mean(runs.map((r) => r.write5m)).toFixed(0)} / 1h ${mean(runs.map((r) => r.write1h)).toFixed(0)} tok, output ${mean(runs.map((r) => r.output)).toFixed(0)} tok`,
    )
    line('total time', runs, (r) => r.ms)
    line('time to first token', runs, (r) => r.firstMs)
    line('cost per call', runs, (r) => r.costUsd * 1e6, 'µUS$')
  }
  const dt = cold.map((c, k) => c.ms - (warm[k]?.ms ?? 0))
  console.log(
    `\nCold minus warm, same pair: mean ${mean(dt).toFixed(0)} ms, median ${stat(dt, 50).toFixed(0)} ms`,
  )
  console.log(
    `Cold minus warm in time to first token: mean ${mean(cold.map((c, k) => c.firstMs - (warm[k]?.firstMs ?? 0))).toFixed(0)} ms`,
  )
}

async function strict() {
  const n = Number(values.n)
  const base = requestBase('haiku')
  const arms = {
    'strict (old)': base.tools.map((t) => ({ ...t, strict: true })),
    'not strict (now)': base.tools,
  }
  for (const text of ['hola', 'cafe 3500']) {
    const times: Record<string, number[]> = { 'strict (old)': [], 'not strict (now)': [] }
    let out = 0
    for (let k = 0; k <= n; k++) {
      for (const [name, tools] of Object.entries(arms)) {
        const t0 = performance.now()
        const r = await client.messages.create({
          ...base,
          tools,
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: `[probe strict-${name}]\n${SYSTEM_PROMPT}`,
              cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
            },
          ],
          messages: [{ role: 'user', content: renderContext({ ...context, text }) }],
        })
        // The first round only writes each arm's cache (and compiles the strict grammar): not timed.
        if (k > 0) times[name]?.push(performance.now() - t0)
        out = r.usage.output_tokens
      }
    }
    console.log(`\n"${text}" (${out} output tokens), ${n} warm calls each, interleaved`)
    for (const [name, xs] of Object.entries(times)) {
      console.log(
        `  ${name.padEnd(18)} p50 ${stat(xs, 50).toFixed(0)} ms   p95 ${stat(xs, 95).toFixed(0)} ms   mean ${mean(xs).toFixed(0)} ms`,
      )
    }
  }
}

async function gap() {
  const wait = Number(values.wait)
  console.log(`write each TTL, wait ${wait} s, send the same request again`)
  await call('warmup', '5m')
  const results = await Promise.all(
    (['5m', '1h'] as const).map(async (ttl) => {
      const nonce = `gap-${ttl}-${Date.now()}`
      const first = await call(nonce, ttl)
      await new Promise((r) => setTimeout(r, wait * 1000))
      const second = await call(nonce, ttl)
      return { ttl, first, second }
    }),
  )
  for (const { ttl, first, second } of results) {
    console.log(
      `TTL ${ttl}: first call wrote 5m ${first.write5m} / 1h ${first.write1h}, read ${first.read}; after ${wait} s: read ${second.read}, wrote 5m ${second.write5m} / 1h ${second.write1h}, ${second.ms.toFixed(0)} ms (${second.read > 0 ? 'HIT' : 'MISS'})`,
    )
  }
}

if (positionals[0] === 'pairs') await pairs()
else if (positionals[0] === 'strict') await strict()
else if (positionals[0] === 'gap') await gap()
else {
  console.error(
    'usage: cache-probe.ts pairs [--n 10] [--ttl 5m|1h] | strict [--n 10] | gap [--wait 330]',
  )
  process.exit(1)
}
process.exit(0)
