import type { Sql } from './db'
import { log } from './log'
import { type Graph, GraphError } from './whatsapp/graph'

export const REPLY_TEXT = 'recibido'
export const REPLY_NON_TEXT = 'por ahora solo entiendo texto'

export interface ProcessorOptions {
  sql: Sql
  graph: Graph
  /** Rows that are `pending` or `processing` for longer than this are taken again by the sweep. */
  staleMs: number
  maxAttempts: number
}

interface Claimed {
  wamid: string
  wa_id: string
  kind: string
  attempts: number
  received_at: Date
  reply_sent_at: Date | null
}

export function createProcessor(o: ProcessorOptions) {
  const { sql, graph } = o
  const staleSecs = o.staleMs / 1000

  /** Takes a row atomically, so two workers (or a worker and the sweep) never both send. */
  async function claim(wamid: string): Promise<Claimed | undefined> {
    const [row] = await sql<Claimed[]>`
      UPDATE inbound_message
      SET status = 'processing', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE wamid = ${wamid}
        AND attempts < ${o.maxAttempts}
        AND (status = 'pending'
          OR (status = 'processing' AND claimed_at < now() - make_interval(secs => ${staleSecs})))
      RETURNING wamid, wa_id, kind, attempts, received_at, reply_sent_at`
    return row
  }

  async function processOne(wamid: string): Promise<void> {
    const m = await claim(wamid)
    if (!m) return
    const started = Date.now()
    const timings: Record<string, number> = {}
    const since = () => Date.now() - m.received_at.getTime()
    try {
      if (m.reply_sent_at) {
        // A crash after the send but before `done`: the reply is out, do not send another.
        await sql`UPDATE inbound_message SET status = 'done', updated_at = now() WHERE wamid = ${m.wamid}`
        log('message_recovered', { wamid: m.wamid })
        return
      }

      try {
        await graph.markReadAndType(m.wamid)
        await sql`UPDATE inbound_message SET typing_sent_at = now() WHERE wamid = ${m.wamid}`
        timings.typing_ms = since()
      } catch (err) {
        // The indicator is cosmetic: still answer.
        log('typing_failed', { wamid: m.wamid, error: errorText(err) })
      }

      const text = m.kind === 'text' ? REPLY_TEXT : REPLY_NON_TEXT
      const outbound = await graph.sendText(m.wa_id, text)
      timings.reply_ms = since()
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO reply (outbound_wamid, inbound_wamid, sent_at)
          VALUES (${outbound}, ${m.wamid}, now())
          ON CONFLICT (outbound_wamid) DO UPDATE
            SET inbound_wamid = EXCLUDED.inbound_wamid, sent_at = EXCLUDED.sent_at`
        await tx`
          UPDATE inbound_message
          SET status = 'done', reply_sent_at = now(), error = NULL, updated_at = now()
          WHERE wamid = ${m.wamid}`
      })
      log('message_done', {
        wamid: m.wamid,
        attempt: m.attempts,
        ...timings,
        total_ms: Date.now() - started,
      })
    } catch (err) {
      const permanent = err instanceof GraphError && err.permanent
      const status = permanent || m.attempts >= o.maxAttempts ? 'failed' : 'pending'
      await sql`
        UPDATE inbound_message SET status = ${status}, error = ${errorText(err)}, updated_at = now()
        WHERE wamid = ${m.wamid}`
      log('message_error', {
        wamid: m.wamid,
        attempt: m.attempts,
        status,
        error: errorText(err),
        ...timings,
      })
    }
  }

  async function sweep(): Promise<number> {
    const rows = await sql<{ wamid: string }[]>`
      SELECT wamid FROM inbound_message
      WHERE attempts < ${o.maxAttempts}
        AND ((status = 'pending' AND updated_at < now() - make_interval(secs => ${staleSecs}))
          OR (status = 'processing' AND claimed_at < now() - make_interval(secs => ${staleSecs})))
      ORDER BY id LIMIT 50`
    for (const r of rows) await processOne(r.wamid)
    if (rows.length) log('sweep', { retried: rows.length })
    return rows.length
  }

  return { processOne, sweep }
}

export type Processor = ReturnType<typeof createProcessor>

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}
