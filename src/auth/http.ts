import type { ServerResponse } from 'node:http'

/** Writes a web `Response` to a node response: status, headers (cookies apart) and the whole body. */
export async function sendWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}
