import type { Sql } from './db'
import type { Timings } from './timings'

/** One inbound text message with the times `pnpm latency` reads. Numbers come back from Postgres as strings or numbers. */
export interface LatencyRow {
  /** `text`, `image` or `audio`: the headline numbers are the text messages'; the stages cover all three. */
  kind: string
  typing: number | string | null
  reply: number | string | null
  delivered: number | string | null
  model: number | string | null
  type: string | null
  turns: number | string | null
  /** Per-stage times; null on rows from before they were stored. */
  timings: Timings | null
}

/** The last `last` inbound text messages, newest first, with the stamps and stages the report reads. */
export function fetchLatencyRows(sql: Sql, last: number): Promise<LatencyRow[]> {
  return sql<LatencyRow[]>`
    SELECT
      extract(epoch FROM m.typing_sent_at - m.received_at) * 1000 AS typing,
      extract(epoch FROM m.reply_sent_at - m.received_at) * 1000 AS reply,
      extract(epoch FROM r.delivered_at - m.meta_ts) * 1000 AS delivered,
      m.model_ms AS model,
      COALESCE(m.action, m.command->>'type') AS type,
      m.model_turns AS turns,
      m.timings, m.kind
    FROM (SELECT * FROM inbound_message WHERE kind IN ('text', 'image', 'audio') ORDER BY id DESC LIMIT ${last}) m
    LEFT JOIN reply r ON r.inbound_id = m.id`
}

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v)

/** Nearest-rank percentile of the values that are not null, or null when there are none. */
export function percentile(values: (number | null)[], p: number): number | null {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] as number
}

const show = (ms: number | null, unit = 'ms') => (ms === null ? 'n/a' : `${Math.round(ms)} ${unit}`)

function line(name: string, values: (number | null)[], unit = 'ms'): string {
  const n = values.filter((x) => x !== null).length
  return `${name.padEnd(34)} p50 ${show(percentile(values, 50), unit).padStart(9)}   p95 ${show(percentile(values, 95), unit).padStart(9)}   (n=${n})`
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** What one message spent in each stage, from its stored timings (`src/timings.ts`). */
export interface Stages {
  claimed: number
  reads: number
  media: number
  /** Model calls plus the reads that followed them: the whole agent loop. Null when no model ran (answered in code). */
  agent: number | null
  /** The first turn's model call, and the later ones summed (0 when there was no second turn). */
  turn1: number | null
  turn2: number
  find: number
  commit: number | null
  stamp: number | null
  send: number | null
  outputTokens: number
  cacheMiss: boolean | null
}

export function stagesOf(t: Timings): Stages {
  const turns = t.turns ?? []
  const first = turns[0]
  return {
    claimed: t.claimed_ms,
    reads: t.reads_ms ?? 0,
    media: t.media_ms ?? 0,
    agent: turns.length > 0 ? sum(turns.map((x) => x.model_ms + x.find_ms)) : null,
    turn1: first ? first.model_ms : null,
    turn2: sum(turns.slice(1).map((x) => x.model_ms)),
    find: sum(turns.map((x) => x.find_ms)),
    commit: t.commit_ms ?? null,
    stamp: t.stamp_ms ?? null,
    send: t.send_ms ?? null,
    outputTokens: sum(turns.map((x) => x.output)),
    // A miss: the first call read none of the cached prefix.
    cacheMiss: first ? first.cache_read === 0 : null,
  }
}

/** The report, one string per line. Pure: the same rows give the same lines. */
export function renderLatency(rows: LatencyRow[]): string[] {
  const out: string[] = []
  // The headline numbers are the text messages' (a voice note's time includes its transcription).
  const texts = rows.filter((r) => r.kind === 'text')
  const col = (key: 'typing' | 'reply' | 'delivered' | 'model', from = texts) =>
    from.map((r) => num(r[key]))
  const metric = (name: string, key: 'typing' | 'reply' | 'delivered' | 'model', from = texts) =>
    out.push(line(name, col(key, from)))

  const others = rows.length - texts.length
  out.push(
    `Last ${rows.length} inbound messages: ${texts.length} text${others > 0 ? `, ${others} photo or voice` : ''}`,
  )
  metric('received -> typing sent', 'typing')
  metric('received -> reply sent', 'reply')
  metric('model time', 'model')
  // By action (the `action` column; older rows carry their old command type).
  // Targets: log p50 <= 2.0 s, p95 <= 4.0 s; correct, delete and summarize p50 <= 4 s, p95 <= 8 s.
  for (const type of [...new Set(texts.map((r) => r.type ?? 'failed'))].sort()) {
    const of = texts.filter((r) => (r.type ?? 'failed') === type)
    const turns = of.flatMap((r) => (r.turns === null ? [] : [Number(r.turns)]))
    metric(`received -> reply sent, ${type}`, 'reply', of)
    if (turns.length > 0) {
      out.push(
        `${''.padEnd(34)} model turns per message: ${(sum(turns) / turns.length).toFixed(2)}`,
      )
    }
  }
  metric('meta ts -> delivered (1 s steps)', 'delivered')

  // Where the time goes: every message that stored its stages, text, photo or voice, answered or failed
  // (a failed one stores the stages up to its failure: the slowest messages are among them).
  const timed = rows.flatMap((r) => (r.timings ? [{ r, s: stagesOf(r.timings) }] : []))
  out.push('')
  if (timed.length === 0) {
    out.push(
      'Where the time goes: no message has stored stages yet (rows from before the speed pass).',
    )
    return out
  }
  const failed = timed.filter((t) => num(t.r.reply) === null).length
  out.push(
    `Where the time goes (${timed.length} messages with stored stages${failed > 0 ? `, ${failed} of them with no reply sent` : ''}; typing runs beside these)`,
  )
  const stage = (name: string, f: (s: Stages) => number | null) =>
    out.push(
      line(
        name,
        timed.map((t) => f(t.s)),
      ),
    )
  stage('received -> claimed', (s) => s.claimed)
  stage('context reads (db)', (s) => s.reads)
  const withMedia = timed.filter((t) => t.s.media > 0)
  if (withMedia.length > 0)
    out.push(
      line(
        'photo / voice wait',
        withMedia.map((t) => t.s.media),
      ),
    )
  stage('agent loop (model + reads)', (s) => s.agent)
  stage('  model call, turn 1', (s) => s.turn1)
  const second = timed.filter((t) => t.s.turn2 > 0)
  out.push(
    line(
      '  model calls after turn 1',
      second.map((t) => t.s.turn2),
    ),
  )
  const finds = timed.filter((t) => t.s.find > 0)
  out.push(
    line(
      '  find_movements reads',
      finds.map((t) => t.s.find),
    ),
  )
  stage('commit (transaction)', (s) => s.commit)
  stage('send stamp (db)', (s) => s.stamp)
  stage('Graph send', (s) => s.send)
  out.push(
    line(
      'other (rest of received -> sent)',
      timed.map(({ r, s }) => {
        const reply = num(r.reply)
        if (reply === null || s.commit === null || s.stamp === null || s.send === null) return null
        // Not clamped: a negative remainder means the stages overlap or a clock disagrees, and that is worth seeing.
        return (
          reply - (s.claimed + s.reads + s.media + (s.agent ?? 0) + s.commit + s.stamp + s.send)
        )
      }),
    ),
  )

  // Tokens: output speed dominates a Haiku turn, and a cache miss costs a whole prefix write.
  out.push('')
  out.push('Model tokens per message')
  out.push(
    line(
      'output tokens',
      timed.map((t) => t.s.outputTokens),
      'tok',
    ),
  )
  for (const type of [...new Set(timed.map((t) => t.r.type ?? 'failed'))].sort()) {
    const of = timed.filter((t) => (t.r.type ?? 'failed') === type && t.s.turn1 !== null)
    if (of.length === 0) continue
    out.push(
      `${`  ${type}`.padEnd(34)} mean output ${(sum(of.map((t) => t.s.outputTokens)) / of.length).toFixed(0).padStart(4)} tok   (n=${of.length})`,
    )
  }
  const called = timed.filter((t) => t.s.cacheMiss !== null)
  const misses = called.filter((t) => t.s.cacheMiss)
  out.push(
    `prompt cache misses (first call read nothing): ${misses.length} of ${called.length} messages that called the model`,
  )
  const hit = called.filter((t) => !t.s.cacheMiss && t.s.turn1 !== null)
  out.push(
    line(
      '  turn 1 model call, cache hit',
      hit.map((t) => t.s.turn1),
    ),
  )
  out.push(
    line(
      '  turn 1 model call, cache miss',
      misses.map((t) => t.s.turn1),
    ),
  )
  return out
}
