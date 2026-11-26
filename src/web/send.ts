import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

/** What every page of ours is sent with: never cached, never framed, never sniffed, no referrer. */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const csp = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
  `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

/** A fresh nonce for one page: its stylesheet and its script run under it, nothing else does. */
const newNonce = () => randomBytes(16).toString('base64')

/** Sends a page. `render` gets the page's own nonce, which the response's CSP names: a caller never makes or passes one. */
export function sendHtml(
  res: ServerResponse,
  status: number,
  render: (nonce: string) => string,
  extra: Record<string, string> = {},
) {
  const nonce = newNonce()
  res.writeHead(status, { ...PAGE_HEADERS, 'content-security-policy': csp(nonce), ...extra })
  res.end(render(nonce))
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

/** Markdown or plain text for an agent. */
export function sendText(
  res: ServerResponse,
  type: 'markdown' | 'plain',
  text: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(200, {
    'content-type': `text/${type}; charset=utf-8`,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(text)
}
