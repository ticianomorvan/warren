/**
 * Any agent may connect (bring your own agent). A client's `client_id` may be the URL of its metadata document (CIMD): Warren fetches
 * it only over https, from a path (never a bare host), through `@better-auth/cimd/node`, which refuses a host that resolves to a
 * private or reserved address and pins the address it checked. Clients without a document register themselves (DCR, `config.ts`).
 * `CLIENT_HOSTS` is only the browser side: the origins whose pages may call `/mcp` directly.
 */
export const CLIENT_HOSTS: readonly string[] = ['claude.ai', 'claude.com']

/** True for a client id that may be fetched as a metadata document: https, no credentials or port, a path. Checked before any fetch. */
export function clientIdAllowed(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.pathname.length > 1
    )
  } catch {
    return false
  }
}

/** The exact origins a browser page may call `/mcp` from: ours and the clients'. A request with no `Origin` is not a browser and passes. */
export const allowedOrigins = (publicUrl: string): Set<string> =>
  new Set([new URL(publicUrl).origin, ...CLIENT_HOSTS.map((h) => `https://${h}`)])
