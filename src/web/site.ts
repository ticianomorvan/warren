import type { IncomingMessage, ServerResponse } from 'node:http'
import { documentPage } from '../auth/pages'
import { llms, PAGES, setup } from './content'
import { renderMarkdown } from './markdown'
import { sendHtml, sendText } from './send'

/** Serves the public documents; false when the path is not one of them. */
export type Site = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean

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
 * Every document takes the public URL, so a command or a link names the host that serves it. They are built once, here.
 */
export function createSite(publicUrl: string): Site {
  const setupMd = setup(publicUrl)
  const llmsTxt = llms(publicUrl)
  const documents = PAGES.map((p) => {
    const md = p.md(publicUrl)
    return {
      route: p.route as string,
      twin: p.twin as string,
      title: p.title,
      md,
      html: renderMarkdown(md),
    }
  })
  return (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const path = url.pathname
    if (path === '/setup.md') {
      sendText(res, 'markdown', setupMd)
      return true
    }
    if (path === '/llms.txt') {
      sendText(res, 'plain', llmsTxt)
      return true
    }
    for (const doc of documents) {
      if (path === doc.twin) {
        sendText(res, 'markdown', doc.md)
        return true
      }
      if (path === doc.route) {
        if (wantsMarkdown(req)) {
          sendText(res, 'markdown', doc.md, { vary: 'Accept' })
          return true
        }
        sendHtml(res, 200, (nonce) => documentPage(doc.title, doc.html, nonce), { vary: 'Accept' })
        return true
      }
    }
    return false
  }
}
