import { isAllowed } from '../access'
import type { Sql } from '../core/db'
import { log } from '../log'
import { OUTSIDE_WINDOW } from './graph'
import type { InboundMessage, StatusUpdate } from './payload'

/**
 * The webhook's write. A message is stored before the 200 (after it Meta will not send it again) as `pending`, with its media id
 * (never its bytes, never its raw payload); a sender who is allowed has an account from the first message. The worker decides
 * what is answered.
 */

const seconds = (n: number | undefined) => (n === undefined ? null : new Date(n * 1000))

/** The account of a WhatsApp id, created the first time it is asked for. */
export async function accountFor(sql: Sql, waId: string): Promise<number> {
  const find = async () => {
    const [row] = await sql<{ id: number }[]>`
      SELECT account_id AS id FROM account_address WHERE channel = 'whatsapp' AND address = ${waId}`
    return row?.id
  }
  const found = await find()
  if (found !== undefined) return found
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    const [account] = await tx<
      { id: number }[]
    >`INSERT INTO account DEFAULT VALUES RETURNING id AS id`
    const created = account as { id: number }
    const rows = await tx`
      INSERT INTO account_address (account_id, channel, address) VALUES (${created.id}, 'whatsapp', ${waId})
      ON CONFLICT (channel, address) DO NOTHING RETURNING account_id`
    if (rows.length > 0) return created.id
    // Another request made it first: drop this account, which nothing refers to yet.
    await tx`DELETE FROM account WHERE id = ${created.id}`
    return (await find()) as number
  })
}

export interface IngestOptions {
  /** Normalized ids that get a reply (`*` is everyone): only these get an account. */
  allowed: string[]
}

export function createIngest(sql: Sql, o: IngestOptions) {
  return {
    /** Stores a message as `pending`. False when the wamid was already stored (Meta's retry). */
    async message(m: InboundMessage): Promise<boolean> {
      if (isAllowed(o.allowed, m.from)) await accountFor(sql, m.from)
      const rows = await sql`
        INSERT INTO wa_message (wamid, wa_id, kind, text, media_id, meta_ts, context_wamid)
        VALUES (${m.id}, ${m.from}, ${m.type}, ${m.text}, ${m.mediaId}, ${seconds(m.timestamp)}, ${m.contextId})
        ON CONFLICT (wamid) DO NOTHING
        RETURNING id`
      if (rows.length > 0) log('message_received', { wamid: m.id, kind: m.type })
      return rows.length > 0
    },

    /**
     * One statement, any arrival order. A `read` also stands in for a missing `delivered`. A status for a reminder's wamid belongs to its
     * `reminder_send`, not to `reply`.
     */
    async status(s: StatusUpdate): Promise<void> {
      const at = seconds(s.timestamp) ?? new Date()
      const code = s.errors?.[0]?.code
      if (await reminderStatus(sql, { wamid: s.id, status: s.status, code })) return
      const delivered = s.status === 'delivered' || s.status === 'read' ? at : null
      await sql`
        INSERT INTO reply (outbound_wamid, delivered_at, read_at, failed_at)
        VALUES (${s.id}, ${delivered}, ${s.status === 'read' ? at : null}, ${s.status === 'failed' ? at : null})
        ON CONFLICT (outbound_wamid) DO UPDATE SET
          delivered_at = LEAST(reply.delivered_at, EXCLUDED.delivered_at),
          read_at = COALESCE(reply.read_at, EXCLUDED.read_at),
          failed_at = COALESCE(reply.failed_at, EXCLUDED.failed_at)`
      if (s.status === 'failed') {
        log('status_failed', { outbound: s.id, code, title: s.errors?.[0]?.title }, 'error')
      }
    },
  }
}

export type Ingest = ReturnType<typeof createIngest>

/**
 * A delivery status for a reminder's send. A send that Meta accepted and later reports failed is marked: a text refused outside the
 * 24 h window (131047) is sent again as the template, any other failure ends it. True when the wamid is a reminder's.
 */
async function reminderStatus(
  sql: Sql,
  s: { wamid: string; status: string; code: number | undefined },
): Promise<boolean> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql
    const [row] = await tx<{ id: number; kind: string; status: string }[]>`
      SELECT id AS id, kind, status FROM reminder_send WHERE wamid = ${s.wamid} FOR UPDATE`
    if (!row) return false
    if (s.status !== 'failed' || row.status !== 'sent') return true
    const status = row.kind === 'text' && s.code === OUTSIDE_WINDOW ? 'retry_template' : 'failed'
    await tx`UPDATE reminder_send SET status = ${status}, error_code = ${s.code ?? null} WHERE id = ${row.id}`
    log('reminder_status_failed', { send: row.id, code: s.code, status }, 'error')
    return true
  })
}
