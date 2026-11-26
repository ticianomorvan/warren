import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AuthRoutes } from './auth/routes'
import { log } from './log'
import type { Site } from './web/site'

export interface AppOptions {
  /** The OAuth server's routes and the account page (docs/design.md, "Auth"); without them none of their paths exist. */
  auth?: AuthRoutes
  /** The public documents: landing, `/setup.md`, `/llms.txt`, privacy and terms. */
  site?: Site
  /** `/mcp`: the MCP endpoint (its door, origin check and tools). Without it the path does not exist. */
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /**
   * The host `/mcp`, the OAuth server and the web answer on (`PUBLIC_URL`'s): a request for them on another host gets 404, so tokens and
   * metadata name one issuer. A function because a test binds it once its server listens.
   */
  publicHost?: () => string
  /** Which deploy this is (the commit and the deployment id, space apart). `/health` says it in `x-warren-build`. */
  build?: string
}

function send(res: ServerResponse, status: number, body = ''): void {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(body)
}

/** Plain node:http: a few routes do not need a framework. */
export function createApp(o: AppOptions): Server {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400)
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        ...(o.build ? { 'x-warren-build': o.build } : {}),
      })
      return void res.end('ok')
    }
    const onPublicHost = !o.publicHost || req.headers.host === o.publicHost()
    if (!onPublicHost) return send(res, 404)
    if (url.pathname === '/mcp' && o.mcp) return o.mcp(req, res)
    if (o.auth && (await o.auth(req, res, url))) return
    if (o.site?.(req, res, url)) return
    send(res, 404)
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('request_error', { error: err instanceof Error ? err.message : String(err) }, 'error')
      if (!res.headersSent) send(res, 500)
    })
  })
}
