import type { Sql } from '../core/db'
import { REDACTED_BODY } from '../redact'
import type { Timings } from '../timings'

/**
 * The rules of `wa_message` as a queue: what is due, who owns a row, and which writes are allowed. Every post-claim write is
 * guarded by `status = 'processing' AND attempts = <claimed>`, so a slow worker whose row was taken over cannot change it.
 */

/** What a worker holds after claiming a row. Every later write checks `id` and `attempts`. */
export interface Claim {
  id: number
  wamid: string
  wa_id: string
  kind: string
  attempts: number
  /** The text, a photo's caption; null for a voice note (its transcript is stored at the commit point). */
  text: string | null
  /** A photo's or voice note's media id, to download it (the bytes are never stored). */
  mediaId: string | null
  /** Ms since `received_at` when the row was claimed (database clock). The deadlines count from it. */
  ageMs: number
  /** `performance.now()` when the claim came back, to age `ageMs` up to when the work starts. */
  claimedAt: number
  /** The message's own time (`meta_ts`, else `received_at`): the Argentine day is taken from it. */
  messageAt: Date
  /** The reply of the turn this row already committed; set means the agent must not run again. */
  reply: string | null
  typingSent: boolean
}

export type Settled = 'done' | 'failed' | 'pending' | 'unknown' | 'ignored'

export interface QueueOptions {
  /** A `processing` row older than this is presumed abandoned. */
  staleMs: number
  maxAttempts: number
  /**
   * The kinds of message whose rows hold their sender's next message back until they have a turn: the ones that go through the agent.
   * Any other kind (a sticker, a reaction, an audio no one can transcribe) writes nothing the next message could depend on, so its reply
   * being sent never holds the sender back. This is the one place that rule lives.
   */
  blocking: readonly string[]
}

/** A `processing` row whose claim is older than `staleMs`: its worker is presumed gone. */
const staleClaim = (sql: Sql, staleMs: number) =>
  sql`claimed_at < now() - make_interval(secs => ${staleMs / 1000})`

export function createQueue(sql: Sql, o: QueueOptions) {
  const owned = (c: Claim) =>
    sql`id = ${c.id} AND status = 'processing' AND attempts = ${c.attempts}`

  return {
    /**
     * Takes the sender's oldest due row, atomically, and only when no older row of that sender is open, uncommitted and not stale: a row
     * another worker holds (the old instance of a deploy, a slower claim) is not overtaken by a newer one. Due means pending, or
     * processing for longer than `staleMs` with no send started. Claims run in id order. Null when there is nothing to take.
     */
    async claimNext(waId: string): Promise<Claim | null> {
      const secs = o.staleMs / 1000
      const rows = await sql<
        (Omit<Claim, 'ageMs' | 'claimedAt' | 'messageAt'> & {
          ageMs: string
          messageAt: Date
        })[]
      >`
        WITH picked AS (
          SELECT m.id FROM wa_message m
          WHERE m.wa_id = ${waId} AND m.attempts < ${o.maxAttempts}
            AND (m.status = 'pending' OR (m.status = 'processing' AND m.claimed_at < now() - make_interval(secs => ${secs}) AND m.send_started_at IS NULL))
            AND NOT EXISTS (
              SELECT 1 FROM wa_message o
              WHERE o.wa_id = m.wa_id AND o.id < m.id AND o.status IN ('pending', 'processing') AND o.turn_id IS NULL
                AND o.kind IN ${sql([...o.blocking])}
                AND NOT (o.status = 'processing' AND o.claimed_at < now() - make_interval(secs => ${secs})))
          ORDER BY m.id LIMIT 1
          FOR UPDATE OF m SKIP LOCKED),
        claimed AS (
          UPDATE wa_message SET status = 'processing', attempts = attempts + 1, claimed_at = now()
          WHERE id IN (SELECT id FROM picked)
          RETURNING id, wamid, wa_id, kind, attempts, text, media_id, turn_id, typing_sent_at,
            COALESCE(meta_ts, received_at) AS message_at, extract(epoch FROM now() - received_at) * 1000 AS age_ms)
        SELECT c.id::int AS id, c.wamid, c.wa_id, c.kind, c.attempts, c.text, c.media_id AS "mediaId",
          c.typing_sent_at IS NOT NULL AS "typingSent", c.message_at AS "messageAt", c.age_ms AS "ageMs", t.reply
        FROM claimed c LEFT JOIN turn t ON t.id = c.turn_id`
      const row = rows[0]
      return row ? { ...row, ageMs: Number(row.ageMs), claimedAt: performance.now() } : null
    },

    /**
     * Housekeeping, the sweep's alone (a claim never does it, so a burst of kicks does not repeat it): settles the rows nobody will work on
     * again. A row that died after its send started is `unknown`; a row out of attempts is `failed`.
     */
    async tidy(): Promise<void> {
      await sql`
        UPDATE wa_message SET status = 'unknown',
          error = 'send outcome unknown: the worker died or timed out after the send started'
        WHERE status = 'processing' AND ${staleClaim(sql, o.staleMs)} AND send_started_at IS NOT NULL`
      await sql`
        UPDATE wa_message SET status = 'failed', error = COALESCE(error, 'attempts exhausted')
        WHERE attempts >= ${o.maxAttempts}
          AND (status = 'pending' OR (status = 'processing' AND ${staleClaim(sql, o.staleMs)} AND send_started_at IS NULL))`
    },

    /** The senders that have a row to work on: the sweep starts one lane for each. */
    async senders(): Promise<string[]> {
      const rows = await sql<{ wa_id: string }[]>`
        SELECT DISTINCT wa_id FROM wa_message
        WHERE attempts < ${o.maxAttempts}
          AND (status = 'pending' OR (status = 'processing' AND ${staleClaim(sql, o.staleMs)} AND send_started_at IS NULL))`
      return rows.map((r) => r.wa_id)
    },

    /**
     * First signal on receipt: stamps the typing indicator of the sender's pending rows that wait behind an older open one (so their lane
     * will not reach them for a while) and have none yet, and returns their wamids. Stamped before it is sent, so two kicks never both
     * send it. It writes nothing but `typing_sent_at` on rows nobody owns; a claim that finds one locked skips it, so the caller kicks
     * the lane again afterwards.
     */
    async signalWaiting(waId: string): Promise<string[]> {
      const rows = await sql<{ wamid: string }[]>`
        UPDATE wa_message m SET typing_sent_at = now()
        WHERE m.wa_id = ${waId} AND m.status = 'pending' AND m.typing_sent_at IS NULL AND m.turn_id IS NULL
          AND EXISTS (
            SELECT 1 FROM wa_message o
            WHERE o.wa_id = m.wa_id AND o.id < m.id AND o.status IN ('pending', 'processing') AND o.turn_id IS NULL)
        RETURNING m.wamid`
      return rows.map((r) => r.wamid)
    },

    /** Stamps the typing indicator (the first stamp stays). Returns ms since received (database clock), null if not owned. */
    async recordTyping(c: Claim): Promise<number | null> {
      const [row] = await sql<{ ms: number }[]>`
        UPDATE wa_message SET typing_sent_at = COALESCE(typing_sent_at, now())
        WHERE ${owned(c)}
        RETURNING extract(epoch FROM now() - received_at) * 1000 AS ms`
      return row ? Number(row.ms) : null
    },

    /**
     * Committed before the interim note is sent, so it goes out at most once. False when it was already sent, the reply send has
     * started, or the failure path has: then do not send it.
     */
    async recordInterim(c: Claim): Promise<boolean> {
      const rows = await sql`
        UPDATE wa_message SET interim_sent_at = now()
        WHERE ${owned(c)} AND interim_sent_at IS NULL AND send_started_at IS NULL AND failure_sent_at IS NULL
        RETURNING id`
      return rows.length > 0
    },

    /**
     * Ends the message as `failed` and commits to sending the failure notice, which then goes out at most once. False when the reply
     * send has started, the turn was committed, or the notice was already started: say nothing. `redact` wipes the text.
     */
    async recordFailure(
      c: Claim,
      error: string,
      trace?: { audit: unknown[] },
      timings?: Timings,
      redact = false,
    ): Promise<boolean> {
      const rows = await sql`
        UPDATE wa_message
        SET status = 'failed', error = ${error}, failure_sent_at = now(),
          ${redact ? sql`text = ${REDACTED_BODY},` : sql``}
          audit = COALESCE(${trace ? sql.json(trace.audit as never) : null}, audit),
          timings = COALESCE(timings, '{}'::jsonb) || COALESCE(${timings ? sql.json(timings as never) : null}::jsonb, '{}'::jsonb)
        WHERE ${owned(c)} AND send_started_at IS NULL AND turn_id IS NULL AND failure_sent_at IS NULL
        RETURNING id`
      return rows.length > 0
    },

    /** Keeps the failure notice's wamid for its delivery status. The message stays `failed`. */
    async recordFailureSent(c: Claim, outboundWamid: string): Promise<void> {
      await sql`
        INSERT INTO reply (outbound_wamid, wa_message_id, sent_at) VALUES (${outboundWamid}, ${c.id}, now())
        ON CONFLICT (outbound_wamid) DO UPDATE SET wa_message_id = EXCLUDED.wa_message_id, sent_at = EXCLUDED.sent_at`
    },

    /** Committed before the Graph call. False means the claim was lost: do not send. */
    async recordSendStarted(c: Claim): Promise<boolean> {
      const rows =
        await sql`UPDATE wa_message SET send_started_at = now() WHERE ${owned(c)} RETURNING id`
      return rows.length > 0
    },

    /**
     * Stores the outbound wamid and finishes the row. It also accepts `unknown`: a reply that was in flight when the sweep gave up on it
     * is now known to be sent. Returns ms since received.
     */
    async recordReplySent(
      c: Claim,
      outboundWamid: string,
      timings?: Timings,
    ): Promise<number | null> {
      return sql.begin(async (tx) => {
        await tx`
          INSERT INTO reply (outbound_wamid, wa_message_id, sent_at) VALUES (${outboundWamid}, ${c.id}, now())
          ON CONFLICT (outbound_wamid) DO UPDATE SET wa_message_id = EXCLUDED.wa_message_id, sent_at = EXCLUDED.sent_at`
        const [row] = await tx<{ ms: number }[]>`
          UPDATE wa_message
          SET status = 'done', reply_sent_at = now(), error = NULL,
            timings = COALESCE(timings, '{}'::jsonb) || COALESCE(${timings ? tx.json(timings as never) : null}::jsonb, '{}'::jsonb)
          WHERE id = ${c.id} AND attempts = ${c.attempts} AND status IN ('processing', 'unknown')
          RETURNING extract(epoch FROM now() - received_at) * 1000 AS ms`
        return row ? Number(row.ms) : null
      })
    },

    /**
     * Moves an owned row out of `processing`. `pending` sends it back (clearing the send mark: the caller knows nothing was sent).
     * Returns false if the claim was lost.
     */
    async settle(c: Claim, status: Exclude<Settled, 'done'>, error?: string): Promise<boolean> {
      const clearSend = status === 'pending' || status === 'ignored'
      const rows = await sql`
        UPDATE wa_message
        SET status = ${status}, error = ${error ?? null},
            send_started_at = ${clearSend ? null : sql`send_started_at`}
        WHERE ${owned(c)} RETURNING id`
      return rows.length > 0
    },

    /** The guard of the commit point: the row is still this worker's, no turn is committed for it and no failure notice has started. Locked until the end of the transaction. */
    async holds(tx: Sql, c: Claim): Promise<boolean> {
      const held = await tx`
        SELECT id FROM wa_message
        WHERE id = ${c.id} AND status = 'processing' AND attempts = ${c.attempts} AND turn_id IS NULL AND failure_sent_at IS NULL
        FOR UPDATE`
      return held.length > 0
    },

    /** Inside the commit transaction, once the turn row exists: ties the message to it, with the trace and the stored text. */
    async linkTurn(
      tx: Sql,
      c: Claim,
      turnId: number,
      trace: { text?: string; audit: unknown; timings: Timings },
    ): Promise<void> {
      await tx`
        UPDATE wa_message
        SET turn_id = ${turnId}, text = COALESCE(${trace.text ?? null}, text),
            audit = ${tx.json(trace.audit as never)}, timings = COALESCE(timings, '{}'::jsonb) || ${tx.json(trace.timings as never)}
        WHERE id = ${c.id}`
    },
  }
}

export type Queue = ReturnType<typeof createQueue>
