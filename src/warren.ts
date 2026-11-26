import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createApp } from './app'
import { createAuth } from './auth/config'
import { type AuthRoutes, createAuthRoutes } from './auth/routes'
import type { Config } from './config'
import type { Sql } from './core/db'
import { log } from './log'
import { createDoor } from './mcp/door'
import { createMcpEndpoint } from './mcp/endpoint'
import { createSite, type Site } from './web/site'

/** What Warren needs from outside. The server gives real ones; tests give doubles. */
export interface WarrenDeps {
  sql: Sql
  config: { auth?: Config['auth'] }
  /** Ready-made OAuth routes (tests late-bind them to the server's own origin); else built from `config.auth`. */
  authRoutes?: AuthRoutes
  /** The ready-made public documents, late-bound the same way. */
  site?: Site
  /** The ready-made `/mcp` handler, late-bound the same way. */
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  clock?: () => Date
  /** The host of `/mcp`, the OAuth server and the web; default `config.auth`'s. A function, so a test can bind it after it listens. */
  publicHost?: () => string
  /** The deploy's identity, shown by `/health` so `pnpm probe --expect` can tell which version answers. */
  build?: string
}

export interface Warren {
  server: Server
}

/**
 * The one place the pieces are wired together: the OAuth server, the web, `/mcp` and the HTTP app. `src/server.ts` and the tests start
 * Warren here, so what they run is what production runs. It listens to nothing and starts no timer.
 */
export function createWarren(deps: WarrenDeps): Warren {
  const { sql, config } = deps
  // The sign-in, the OAuth server, the web and `/mcp` exist only when PUBLIC_URL is set (the config then requires the rest).
  let auth = deps.authRoutes
  let mcp = deps.mcp
  let site = deps.site
  if (!auth && config.auth) {
    const instance = createAuth({
      sql,
      publicUrl: config.auth.publicUrl,
      secret: config.auth.secret,
      google: config.auth.google,
      log: (level, message) =>
        log('auth_log', { level, message }, level === 'error' ? 'error' : 'info'),
    })
    auth = createAuthRoutes({ auth: instance, sql, publicUrl: config.auth.publicUrl })
    site = createSite(config.auth.publicUrl)
    mcp = createMcpEndpoint({
      door: createDoor({ auth: instance, sql, publicUrl: config.auth.publicUrl }),
      sql,
      publicUrl: config.auth.publicUrl,
      ...(deps.clock ? { now: deps.clock } : {}),
    })
  }
  const server = createApp({
    ...(deps.build ? { build: deps.build } : {}),
    ...(deps.publicHost
      ? { publicHost: deps.publicHost }
      : config.auth
        ? { publicHost: () => new URL(config.auth?.publicUrl ?? '').host }
        : {}),
    ...(auth ? { auth } : {}),
    ...(site ? { site } : {}),
    ...(mcp ? { mcp } : {}),
  })
  return { server }
}
