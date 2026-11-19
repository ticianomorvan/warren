/** Value of the first header line called `name`, unfolded. Lines come from the signed header set. */
export function headerValue(lines: readonly string[], name: string): string | null {
  const prefix = `${name}:`
  for (const line of lines) {
    if (line.slice(0, prefix.length).toLowerCase() === prefix) {
      return line
        .slice(prefix.length)
        .replace(/\r?\n[ \t]+/g, ' ')
        .trim()
    }
  }
  return null
}

/** Mail addresses in a header value, lower case. */
export function addressesIn(value: string): string[] {
  return [...value.matchAll(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g)].map((m) => m[0].toLowerCase())
}

/**
 * Addresses in the To headers of raw mail, in order. Nothing here is signed yet, so it only
 * decides where a mail goes to be checked, never whether it counts.
 */
export function unsignedToAddresses(raw: Uint8Array): string[] {
  const text = Buffer.from(raw).toString('latin1')
  const end = text.search(/\r?\n\r?\n/)
  const head = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  const out: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (line.slice(0, 3).toLowerCase() === 'to:') out.push(...addressesIn(line.slice(3)))
  }
  return out
}

/** Addresses in the From headers of raw mail. Unsigned: only decides whether a check is worth running. */
export function unsignedFromAddresses(raw: Uint8Array): string[] {
  const text = Buffer.from(raw).toString('latin1')
  const end = text.search(/\r?\n\r?\n/)
  const head = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  const out: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (line.slice(0, 5).toLowerCase() === 'from:') out.push(...addressesIn(line.slice(5)))
  }
  return out
}
