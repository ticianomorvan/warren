/**
 * The agents allowed to connect, in one place. A client's `client_id` is a URL Warren fetches (its metadata document, CIMD), so only
 * these hosts are ever fetched; a browser page may call `/mcp` only from these origins. Adding a client is adding an entry.
 */
export interface Client {
  name: string
  /** The hosts its `client_id` may live on (https only). */
  hosts: readonly string[]
  /** The origins its browser pages call from. */
  origins: readonly string[]
}

export const CLIENTS: readonly Client[] = [
  {
    name: 'Claude',
    hosts: ['claude.ai', 'claude.com'],
    origins: ['https://claude.ai', 'https://claude.com'],
  },
]

/** True for an https client id on the host of an allowed client. Checked before any fetch. */
export function clientIdAllowed(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && CLIENTS.some((c) => c.hosts.includes(url.hostname))
  } catch {
    return false
  }
}

/**
 * The hostnames a browser page may call `/mcp` from (the SDK's `originValidationResponse` compares hostnames, whatever the port): ours and
 * the clients'. A request with no `Origin` is not a browser and passes.
 */
export const originHostnames = (publicUrl: string): string[] => [
  new URL(publicUrl).hostname,
  ...CLIENTS.flatMap((c) => c.origins.map((o) => new URL(o).hostname)),
]
