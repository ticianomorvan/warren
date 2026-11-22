import { isIPv4, isIPv6 } from 'node:net'

/** `a:b:c:d::/64`'s first four groups, from any IPv6 text (`::` expanded, groups without leading zeros). */
function prefix64(ip: string): string {
  const [head = '', tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

/**
 * What an address counts as in a limit: IPv4 as it is, an IPv4-mapped IPv6 as that IPv4, any other IPv6 as its /64
 * (one subscriber is handed a whole /64 and can use every address in it, so the full address would give them
 * unlimited fresh ones). Anything that is not an address is returned as it came.
 */
export function ipKey(raw: string): string {
  const ip = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  if (isIPv4(ip)) return ip
  if (!isIPv6(ip)) return raw.trim()
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1]
  if (dotted && isIPv4(dotted)) return dotted
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (hex) {
    const [high, low] = [Number.parseInt(hex[1] ?? '', 16), Number.parseInt(hex[2] ?? '', 16)]
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return prefix64(ip)
}
