import { createHash, randomBytes, randomInt } from 'node:crypto'
import { whatsappAddress } from '../access'
import type { Sql } from '../core/db'
import { ipKey } from './ip'
import type { SessionLinks } from './plugin'

/** Letters and digits that cannot be read as each other: no 0/O, 1/I/L. 31 ** 6 is about 887 million. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6
/** How long a sign-in can be finished after its page was opened. */
export const LINK_TTL_MINUTES = 10
/** One address may open this many sign-ins in a TTL: a reload keeps its own (the cookie), so a person needs a few at most. */
export const MAX_LINKS_PER_IP = 10
/** All open sign-ins at most: a backstop for many addresses at once, far above what people need. */
export const MAX_OPEN_LINKS = 2000
/** The first key of the advisory lock that serializes opening sign-in pages per address (the second is its hash). See `src/db.ts` for the others. */
const LINK_LOCK = 7203004

export const newCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
export const newSecret = () => randomBytes(32).toString('base64url')
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

/**
 * What the browser sees of its sign-in. `closed` is every end that is not a success (unknown secret, expired,
 * spent, refused): a foreign cookie learns nothing about which.
 */
export type LinkState = 'waiting' | 'asked' | 'confirmed' | 'closed'

export interface OpenedLink {
  code: string
  secret: string
  expiresAt: Date
}

/** What the sign-in page and the browser's session need of the database. The WhatsApp half is `askLink`, `confirmLink`, `declineLink`. */
export interface Links extends SessionLinks {
  /** The sign-in this browser already has open for this client (a reload, or the tab coming back from WhatsApp). */
  current(secret: string, clientName: string): Promise<OpenedLink | null>
  /** A new sign-in for the page, or null when this address (or the table) has too many open. */
  open(clientName: string, ip: string): Promise<OpenedLink | null>
  /** The state of this browser's sign-in, and, once confirmed, the WhatsApp id of the account that confirmed it. */
  state(secret: string): Promise<{ state: LinkState; waId?: string }>
  /** The person said it is not their account: the sign-in is closed. */
  cancel(secret: string): Promise<void>
}

/** Open: not spent, not confirmed, not expired. */
const live = (sql: Sql) => sql`used_at IS NULL AND confirmed_at IS NULL AND expires_at > now()`

/** The page's SQL. */
export function createLinks(sql: Sql): Links {
  return {
    async current(secret, clientName) {
      const [row] = await sql<{ code: string; expiresAt: Date }[]>`
        SELECT code, expires_at AS "expiresAt" FROM link_request
        WHERE secret_hash = ${hashSecret(secret)} AND client_name = ${clientName}
          AND used_at IS NULL AND expires_at > now()`
      return row ? { code: row.code, secret, expiresAt: row.expiresAt } : null
    },

    async open(clientName, ip) {
      const mine = hashSecret(ipKey(ip))
      // One address at a time: the count and the insert are one step, so a burst from it cannot all pass the count.
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${LINK_LOCK}, hashtext(${mine}))`
        const [counts] = await tx<{ open: string; mine: string }[]>`
          SELECT count(*) FILTER (WHERE used_at IS NULL AND expires_at > now()) AS open,
                 count(*) FILTER (WHERE ip_hash = ${mine}
                   AND created_at > now() - make_interval(mins => ${LINK_TTL_MINUTES})) AS mine
          FROM link_request`
        if (Number(counts?.open) >= MAX_OPEN_LINKS || Number(counts?.mine) >= MAX_LINKS_PER_IP) {
          return null
        }
        await tx`DELETE FROM link_request WHERE expires_at < now() - interval '1 day'`
        const secret = newSecret()
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = newCode()
          const rows = await tx<{ expiresAt: Date }[]>`
            INSERT INTO link_request (code, secret_hash, client_name, ip_hash, expires_at)
            VALUES (${code}, ${hashSecret(secret)}, ${clientName}, ${mine},
              now() + make_interval(mins => ${LINK_TTL_MINUTES}))
            ON CONFLICT (code) DO NOTHING
            RETURNING expires_at AS "expiresAt"`
          if (rows[0]) return { code, secret, expiresAt: rows[0].expiresAt }
        }
        throw new Error('no free sign-in code')
      })
    },

    async state(secret) {
      const [row] = await sql<{ state: LinkState; account_id: number | null }[]>`
        SELECT CASE
          WHEN l.used_at IS NOT NULL OR l.expires_at <= now() THEN 'closed'
          WHEN l.confirmed_at IS NOT NULL THEN 'confirmed'
          WHEN l.asked_at IS NOT NULL THEN 'asked'
          ELSE 'waiting' END AS state,
          l.account_id::int AS account_id
        FROM link_request l
        WHERE l.secret_hash = ${hashSecret(secret)}`
      if (!row) return { state: 'closed' }
      // Whose account it is is told only while the sign-in is confirmed and open.
      const waId =
        row.state === 'confirmed' && row.account_id !== null
          ? await whatsappAddress(sql, row.account_id)
          : null
      return { state: row.state, ...(waId ? { waId } : {}) }
    },

    async cancel(secret) {
      await sql`
        UPDATE link_request SET used_at = now()
        WHERE secret_hash = ${hashSecret(secret)} AND used_at IS NULL`
    },

    async spend(secret) {
      const [row] = await sql<{ account_id: string }[]>`
        UPDATE link_request SET used_at = now()
        WHERE secret_hash = ${hashSecret(secret)} AND confirmed_at IS NOT NULL
          AND used_at IS NULL AND expires_at > now()
        RETURNING account_id`
      return row ? Number(row.account_id) : null
    },
  }
}

/*
 * The WhatsApp half. Each runs inside the message's commit transaction (`execute`), so a message that is
 * processed again, or never committed, has changed nothing. Each is guarded by its own state.
 */

/**
 * The sender sent `code`: the sign-in's id and its client's name to ask about, or null when the code is of no use
 * (unknown, expired, spent, or already asked about by someone else). The sender's older open sign-ins are closed:
 * a newer question replaces them.
 */
export async function askLink(
  sql: Sql,
  code: string,
  accountId: number,
): Promise<{ id: number; client: string } | null> {
  const [row] = await sql<{ id: string; client_name: string }[]>`
    UPDATE link_request SET account_id = ${accountId}, asked_at = now()
    WHERE code = ${code} AND ${live(sql)} AND (account_id IS NULL OR account_id = ${accountId})
    RETURNING id, client_name`
  if (!row) return null
  await sql`
    UPDATE link_request SET used_at = now()
    WHERE account_id = ${accountId} AND id <> ${row.id} AND ${live(sql)}`
  return { id: Number(row.id), client: row.client_name }
}

/** The sender's "sí" to the question about sign-in `id`: its client's name, or null when it is no longer open or not theirs. */
export async function confirmLink(sql: Sql, id: number, accountId: number): Promise<string | null> {
  const [row] = await sql<{ client_name: string }[]>`
    UPDATE link_request SET confirmed_at = now()
    WHERE id = ${id} AND account_id = ${accountId} AND ${live(sql)}
    RETURNING client_name`
  return row?.client_name ?? null
}

/** The sender's "no": the sign-in is closed. False when it was no longer open or not theirs. */
export async function declineLink(sql: Sql, id: number, accountId: number): Promise<boolean> {
  const rows = await sql`
    UPDATE link_request SET used_at = now()
    WHERE id = ${id} AND account_id = ${accountId} AND ${live(sql)} RETURNING id`
  return rows.length > 0
}
