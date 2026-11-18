import { promises as dns } from 'node:dns'

/** Same shape mailauth expects: one string[] of chunks per TXT record. */
export type TxtResolver = (name: string, rrtype: string) => Promise<string[][]>

type DohAnswer = { type: number; data: string }

/** DNS-over-HTTPS lookup, so the result does not depend on the function region's resolver. */
export async function resolveTxtOverHttps(
  name: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[][]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`
  const res = await fetchFn(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw Object.assign(new Error(`DoH ${res.status}`), { code: 'ESERVFAIL' })
  const body = (await res.json()) as { Status: number; Answer?: DohAnswer[] }
  if (body.Status === 3) throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' })
  if (body.Status !== 0)
    throw Object.assign(new Error(`DoH rcode ${body.Status}`), { code: 'ESERVFAIL' })
  const records = (body.Answer ?? []).filter((a) => a.type === 16)
  if (records.length === 0) throw Object.assign(new Error('no TXT'), { code: 'ENODATA' })
  // TXT data arrives as one or more quoted chunks: "v=DKIM1; p=abc" "def"
  return records.map((a) => {
    const chunks = [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      (m[1] ?? '').replace(/\\(.)/g, '$1'),
    )
    return chunks.length > 0 ? chunks : [a.data]
  })
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA'])

/** System DNS first; DNS-over-HTTPS when the system resolver fails for any other reason. */
export const defaultTxtResolver: TxtResolver = async (name, rrtype) => {
  if (rrtype !== 'TXT')
    throw Object.assign(new Error(`unsupported rrtype ${rrtype}`), { code: 'ENODATA' })
  try {
    return await dns.resolveTxt(name)
  } catch (err) {
    if (NOT_FOUND.has((err as NodeJS.ErrnoException).code ?? '')) throw err
    return resolveTxtOverHttps(name)
  }
}
