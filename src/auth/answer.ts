import type { Sql } from '../core/db'
import type { Question } from '../core/turn'
import { disconnectAccount } from './disconnect'
import { askLink, confirmLink, declineLink } from './link'

/** What the person is told while connecting an agent (claude.ai, Claude Code) to their account over WhatsApp (docs/design.md, "MCP and auth"), and when cutting it. */
export const REPLY_LINK = {
  /** The one answer to a code that does not work: unknown, expired or already used. It says nothing about which. */
  refused: 'Ese código no sirve: venció o ya se usó. Pedí uno nuevo desde la pantalla de conexión.',
  ask: (client: string) =>
    `¿Conectar ${client} a tu cuenta de Warren? Va a poder ver y anotar tus movimientos. Respondé sí o no.`,
  done: (client: string) => `Listo, ${client} ya está conectado. Volvé a la pantalla de conexión.`,
  declined: 'Está bien, no conecté nada.',
}

/** "desconectar": what was cut. */
export const REPLY_DISCONNECT = {
  none: 'No tenés ninguna conexión activa con Claude u otro agente.',
  done: (n: number) =>
    `Listo, desconecté ${n === 1 ? '1 conexión' : `${n} conexiones`}: ya no pueden ver ni anotar nada. Para volver a conectar, empezá de nuevo desde Claude.`,
}

/** What a message that only connects or disconnects an agent asks for. Neither has a registry tool: they are not the person's ledger. */
export type SignInAnswer =
  | { kind: 'link_ask'; code: string }
  | { kind: 'link_confirm'; linkId: number }
  | { kind: 'link_decline'; linkId: number }
  | { kind: 'disconnect' }

/** What it came to: the reply, the question only the very next "sí" or "no" can answer, and how it ended (for the audit). */
export interface SignInResult {
  reply: string
  question: Question | null
  status: 'asked' | 'refused' | 'applied' | 'gone' | 'nothing'
}

/**
 * Runs the sign-in's own SQL, inside the commit transaction and after the account lock, so a message that is processed again, or never
 * committed, has changed nothing. Code asks; the question the reply carries is the one only the next "sí" or "no" answers.
 */
export async function answerSignIn(
  tx: Sql,
  answer: SignInAnswer,
  accountId: number,
): Promise<SignInResult> {
  switch (answer.kind) {
    case 'link_ask': {
      const asked = await askLink(tx, answer.code, accountId)
      return asked
        ? {
            reply: REPLY_LINK.ask(asked.client),
            question: { options: [], then: { do: 'link', link_id: asked.id } },
            status: 'asked',
          }
        : { reply: REPLY_LINK.refused, question: null, status: 'refused' }
    }
    case 'link_confirm': {
      const client = await confirmLink(tx, answer.linkId, accountId)
      return client
        ? { reply: REPLY_LINK.done(client), question: null, status: 'applied' }
        : { reply: REPLY_LINK.refused, question: null, status: 'gone' }
    }
    case 'link_decline': {
      const closed = await declineLink(tx, answer.linkId, accountId)
      return { reply: REPLY_LINK.declined, question: null, status: closed ? 'applied' : 'gone' }
    }
    case 'disconnect': {
      const cut = await disconnectAccount(tx, accountId)
      return cut === 0
        ? { reply: REPLY_DISCONNECT.none, question: null, status: 'nothing' }
        : { reply: REPLY_DISCONNECT.done(cut), question: null, status: 'applied' }
    }
  }
}
