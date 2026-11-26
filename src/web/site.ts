import type { IncomingMessage, ServerResponse } from 'node:http'
import { documentPage } from '../auth/pages'
import { landing, llms, privacy, setup, terms } from './content'
import { renderMarkdown } from './markdown'
import { newNonce, sendHtml, sendText } from './send'

/** Serves the public documents; false when the path is not one of them. */
export type Site = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean

/** The documents people read as pages; each also has a Markdown twin for agents. */
const DOCUMENTS = {
  '/': { title: 'Warren', md: landing, twin: '/index.md' },
  '/privacy': { title: 'Política de privacidad', md: privacy, twin: '/privacy.md' },
  '/terms': { title: 'Términos de uso', md: terms, twin: '/terms.md' },
} as const

/** Whether the client asks for Markdown before HTML (`Accept: text/markdown`), the way an agent reads a page. */
function wantsMarkdown(req: IncomingMessage): boolean {
  const ranked = String(req.headers.accept ?? '')
    .split(',')
    .map((part) => {
      const [type = '', ...params] = part.trim().split(';')
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined)
      return { type: type.trim().toLowerCase(), q: q === undefined ? 1 : Number(q) }
    })
    .filter((a) => a.q > 0)
  const md = ranked.find((a) => a.type === 'text/markdown')
  const html = ranked.find((a) => a.type === 'text/html' || a.type === 'application/xhtml+xml')
  return md !== undefined && (html === undefined || md.q >= html.q)
}

/**
 * The agent-readable web (docs/design.md, "The web"): the landing, `/privacy` and `/terms` as pages with a Markdown twin
 * (`/privacy.md`, `/terms.md`, and `Accept: text/markdown` on `/`), `/setup.md` for agents, and `/llms.txt` that indexes them.
 * Every document takes the public URL, so a command or a link names the host that serves it.
 */
export function createSite(publicUrl: string): Site {
  return (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const path = url.pathname
    if (path === '/setup.md') {
      sendText(res, 'markdown', setup(publicUrl))
      return true
    }
    if (path === '/llms.txt') {
      sendText(res, 'plain', llms(publicUrl))
      return true
    }
    for (const [route, doc] of Object.entries(DOCUMENTS)) {
      const md = doc.md(publicUrl)
      if (path === doc.twin) {
        sendText(res, 'markdown', md)
        return true
      }
      if (path === route) {
        if (wantsMarkdown(req)) {
          sendText(res, 'markdown', md, { vary: 'Accept' })
          return true
        }
        const nonce = newNonce()
        sendHtml(res, 200, documentPage(doc.title, renderMarkdown(md), nonce), nonce, {
          vary: 'Accept',
        })
        return true
      }
    }
    return false
  }
}
