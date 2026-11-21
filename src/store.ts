import type { Sql } from './db'

/** What a worker holds after claiming a row. Every later write checks `id` and `attempts`. */
export interface Claim {
  id: number
  wamid: string
  wa_id: string
  kind: string
  attempts: number
}

export type Settled = 'done' | 'failed' | 'pending' | 'unknown' | 'ignored'

export interface InboundInput {
  wamid: string
  wa_id: string
  kind: string
  body: string | null
  raw: unknown
  metaTs: Date | null
}

export interface StatusInput {
  wamid: string
  status: string
  at: Date
}

export interface StoreOptions {
  /** A `processing` row older than this is presumed abandoned. */
  staleMs: number
  maxAttempts: number
}

/**
 * The rules of the two tables live here: what is due, who owns a row, and which writes are allowed.
 * Every post-claim write is guarded by `status = 'processing' AND attempts = <claimed>`, so a slow
 * worker whose row was taken over cannot change it.
 */
export function createStore(sql: Sql, o: StoreOptions) {
  const staleSecs = o.staleMs / 1000
  const owned = (c: Claim) =>
    sql`id = ${c.id} AND status = 'processing' AND attempts = ${c.attempts}`

  return {
    /** Inserts as `pending`. False when the wamid was already stored (Meta retry). */
    async recordInbound(m: InboundInput): Promise<boolean> {
      const rows = await sql`
        INSERT INTO inbound_message (wamid, wa_id, kind, body, payload, meta_ts)
        VALUES (${m.wamid}, ${m.wa_id}, ${m.kind}, ${m.body}, ${sql.json(m.raw as never)}, ${m.metaTs})
        ON CONFLICT (wamid) DO NOTHING
        RETURNING id`
      return rows.length > 0
    },

    /** One statement, any arrival order. A `read` also stands in for a missing `delivered`. */
    async recordStatus(s: StatusInput): Promise<void> {
      const delivered = s.status === 'delivered' || s.status === 'read' ? s.at : null
      await sql`
        INSERT INTO reply (outbound_wamid, delivered_at, read_at, failed_at)
        VALUES (${s.wamid}, ${delivered},
                ${s.status === 'read' ? s.at : null},
                ${s.status === 'failed' ? s.at : null})
        ON CONFLICT (outbound_wamid) DO UPDATE SET
          delivered_at = LEAST(reply.delivered_at, EXCLUDED.delivered_at),
          read_at = COALESCE(reply.read_at, EXCLUDED.read_at),
          failed_at = COALESCE(reply.failed_at, EXCLUDED.failed_at)`
    },

    /**
     * Settles rows nobody will work on again, then takes the due ones atomically. Due means pending,
     * or processing for longer than `staleMs`. `wamids` narrows it to the rows of one webhook batch.
     */
    async claimDue(opts: { limit: number; wamids?: string[] }): Promise<Claim[]> {
      const only = opts.wamids ? sql`AND wamid = ANY(${opts.wamids})` : sql``
      const abandoned = sql`status = 'processing' AND claimed_at < now() - make_interval(secs => ${staleSecs})`
      // Only a row that never started to send may be taken over; the rest are settled below.
      const stale = sql`${abandoned} AND send_started_at IS NULL`
      // Died after the send started: whether the user got it is unknown, so never send again.
      await sql`
        UPDATE inbound_message
        SET status = 'unknown', updated_at = now(),
            error = 'send outcome unknown: the worker died or timed out after the send started'
        WHERE ${abandoned} AND send_started_at IS NOT NULL ${only}`
      // Out of attempts: end it rather than leave it open forever.
      await sql`
        UPDATE inbound_message
        SET status = 'failed', updated_at = now(),
            error = COALESCE(error, 'attempts exhausted')
        WHERE attempts >= ${o.maxAttempts} AND (status = 'pending' OR (${stale})) ${only}`
      return sql<Claim[]>`
        UPDATE inbound_message
        SET status = 'processing', attempts = attempts + 1, claimed_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM inbound_message
          WHERE attempts < ${o.maxAttempts} AND (status = 'pending' OR (${stale})) ${only}
          ORDER BY id LIMIT ${opts.limit}
          FOR UPDATE SKIP LOCKED)
        RETURNING id, wamid, wa_id, kind, attempts`
    },

    /** Stamps the typing indicator. Returns ms since received (database clock), null if not owned. */
    async recordTyping(c: Claim): Promise<number | null> {
      const [row] = await sql<{ ms: number }[]>`
        UPDATE inbound_message SET typing_sent_at = now()
        WHERE ${owned(c)}
        RETURNING extract(epoch FROM now() - received_at) * 1000 AS ms`
      return row ? Number(row.ms) : null
    },

    /** Committed before the Graph call. False means the claim was lost: do not send. */
    async recordSendStarted(c: Claim): Promise<boolean> {
      const rows = await sql`
        UPDATE inbound_message SET send_started_at = now(), updated_at = now()
        WHERE ${owned(c)} RETURNING id`
      return rows.length > 0
    },

    /**
     * Stores the outbound wamid and finishes the row. It also accepts `unknown`: a reply that was in
     * flight when the sweep gave up on it is now known to be sent. Returns ms since received.
     */
    async recordReplySent(c: Claim, outboundWamid: string): Promise<number | null> {
      return sql.begin(async (tx) => {
        await tx`
          INSERT INTO reply (outbound_wamid, inbound_id, sent_at)
          VALUES (${outboundWamid}, ${c.id}, now())
          ON CONFLICT (outbound_wamid) DO UPDATE
            SET inbound_id = EXCLUDED.inbound_id, sent_at = EXCLUDED.sent_at`
        const [row] = await tx<{ ms: number }[]>`
          UPDATE inbound_message
          SET status = 'done', reply_sent_at = now(), error = NULL, updated_at = now()
          WHERE id = ${c.id} AND attempts = ${c.attempts} AND status IN ('processing', 'unknown')
          RETURNING extract(epoch FROM now() - received_at) * 1000 AS ms`
        return row ? Number(row.ms) : null
      })
    },

    /**
     * Moves an owned row out of `processing`. `retry` sends it back to `pending` (clearing the send
     * mark: the caller knows nothing was sent). Returns false if the claim was lost.
     */
    async settle(c: Claim, status: Exclude<Settled, 'done'>, error?: string): Promise<boolean> {
      const clearSend = status === 'pending' || status === 'ignored'
      const rows = await sql`
        UPDATE inbound_message
        SET status = ${status}, error = ${error ?? null}, updated_at = now(),
            send_started_at = ${clearSend ? null : sql`send_started_at`}
        WHERE ${owned(c)} RETURNING id`
      return rows.length > 0
    },
  }
}

export type Store = ReturnType<typeof createStore>
