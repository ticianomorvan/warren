/**
 * The agents allowed to connect, in one place. A client's `client_id` is a URL Warren fetches (its metadata document, CIMD), so only
 * these hosts are ever fetched, and a browser page may call `/mcp` only from `https://<host>` of one of them (or from our own origin).
 * Adding a client is adding its host.
 */
export const CLIENT_HOSTS: readonly string[] = ['claude.ai', 'claude.com']

/** True for an https client id on an allowed client's host. Checked before any fetch. */
export function clientIdAllowed(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && CLIENT_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

/** The exact origins a browser page may call `/mcp` from: ours and the clients'. A request with no `Origin` is not a browser and passes. */
export const allowedOrigins = (publicUrl: string): Set<string> =>
  new Set([new URL(publicUrl).origin, ...CLIENT_HOSTS.map((h) => `https://${h}`)])
