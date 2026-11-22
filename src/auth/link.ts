import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { Sql } from '../db'
import { REPLY_LINK } from '../render'
import { isNo, isYes, linkCode } from '../resolve'
import type { SessionLinks } from './plugin'

/** Letters and digits that cannot be read as each other: no 0/O, 1/I/L. 31 ** 6 is about 887 million. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6
/** How long a sign-in can be finished after its page was opened. */
export const LINK_TTL_MINUTES = 10
/** Open sign-ins at most: a page that anyone can open must not be a way to fill the table. */
export const MAX_OPEN_LINKS = 200

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

/** What the person's WhatsApp message may do to a sign-in, and what the browser may read of it. */
export interface Links extends SessionLinks {
  /** The sign-in this browser already has open for this client (a reload, or the tab coming back from WhatsApp). */
  current(secret: string, clientName: string): Promise<OpenedLink | null>
  /** A new sign-in for the page, or null when too many are open. */
  open(clientName: string): Promise<OpenedLink | null>
  state(secret: string): Promise<LinkState>
  /** An allowed sender sent `code`: the client's name to ask about, or null when the code is of no use. */
  ask(code: string, accountId: number): Promise<string | null>
  /** The client the sender's newest open question is about, if any. */
  awaiting(accountId: number): Promise<string | null>
  /** The sender's "sí" to the newest open question: its client, or null when there is none. */
  confirm(accountId: number): Promise<string | null>
  /** The sender's "no": closes every open question of theirs. */
  decline(accountId: number): Promise<boolean>
}

const live = (sql: Sql) => sql`used_at IS NULL AND confirmed_at IS NULL AND expires_at > now()`

/** The sign-in's SQL. One statement per rule, each guarded by its own state, so a replayed message changes nothing. */
export function createLinks(sql: Sql): Links {
  /** The sender's newest open question. */
  const newest = (accountId: number) => sql`
    SELECT id, client_name FROM link_request
    WHERE account_id = ${accountId} AND ${live(sql)}
    ORDER BY asked_at DESC, id DESC LIMIT 1`

  return {
    async current(secret, clientName) {
      const [row] = await sql<{ code: string; expiresAt: Date }[]>`
        SELECT code, expires_at AS "expiresAt" FROM link_request
        WHERE secret_hash = ${hashSecret(secret)} AND client_name = ${clientName}
          AND used_at IS NULL AND expires_at > now()`
      return row ? { code: row.code, secret, expiresAt: row.expiresAt } : null
    },

    async open(clientName) {
      const [open] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM link_request WHERE used_at IS NULL AND expires_at > now()`
      if (Number(open?.n) >= MAX_OPEN_LINKS) return null
      await sql`DELETE FROM link_request WHERE expires_at < now() - interval '1 day'`
      const secret = newSecret()
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode()
        const rows = await sql<{ expiresAt: Date }[]>`
          INSERT INTO link_request (code, secret_hash, client_name, expires_at)
          VALUES (${code}, ${hashSecret(secret)}, ${clientName},
            now() + make_interval(mins => ${LINK_TTL_MINUTES}))
          ON CONFLICT (code) DO NOTHING
          RETURNING expires_at AS "expiresAt"`
        if (rows[0]) return { code, secret, expiresAt: rows[0].expiresAt }
      }
      throw new Error('no free sign-in code')
    },

    async state(secret) {
      const [row] = await sql<{ state: LinkState }[]>`
        SELECT CASE
          WHEN used_at IS NOT NULL OR expires_at <= now() THEN 'closed'
          WHEN confirmed_at IS NOT NULL THEN 'confirmed'
          WHEN asked_at IS NOT NULL THEN 'asked'
          ELSE 'waiting' END AS state
        FROM link_request WHERE secret_hash = ${hashSecret(secret)}`
      return row?.state ?? 'closed'
    },

    async ask(code, accountId) {
      const [row] = await sql<{ client_name: string }[]>`
        UPDATE link_request SET account_id = ${accountId}, asked_at = now()
        WHERE code = ${code} AND ${live(sql)} AND (account_id IS NULL OR account_id = ${accountId})
        RETURNING client_name`
      return row?.client_name ?? null
    },

    async awaiting(accountId) {
      const [row] = await sql<{ client_name: string }[]>`${newest(accountId)}`
      return row?.client_name ?? null
    },

    async confirm(accountId) {
      const [row] = await sql<{ client_name: string }[]>`
        UPDATE link_request SET confirmed_at = now()
        WHERE id = (SELECT id FROM (${newest(accountId)}) q) AND ${live(sql)}
        RETURNING client_name`
      return row?.client_name ?? null
    },

    async decline(accountId) {
      const rows = await sql`
        UPDATE link_request SET used_at = now()
        WHERE account_id = ${accountId} AND ${live(sql)} RETURNING id`
      return rows.length > 0
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

/**
 * Code's answer to a sign-in message, or null when the message is not one (it goes on to the agent). The code
 * is read first, whatever else is open. A bare "sí" or "no" belongs to a sign-in only when no other question is
 * open: the newest question owns the next answer, and a question the person was asked after the sign-in's is newer.
 */
export async function answerLink(
  links: Links,
  m: { text: string; accountId: number; questionOpen: boolean },
): Promise<string | null> {
  const code = linkCode(m.text)
  if (code) {
    const client = await links.ask(code, m.accountId)
    return client ? REPLY_LINK.ask(client) : REPLY_LINK.refused
  }
  if (m.questionOpen) return null
  if (isYes(m.text)) {
    const client = await links.confirm(m.accountId)
    return client ? REPLY_LINK.done(client) : null
  }
  if (isNo(m.text)) return (await links.decline(m.accountId)) ? REPLY_LINK.declined : null
  return null
}
