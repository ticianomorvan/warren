/**
 * Checks a saved mail file against the bank sender policy, using live DNS.
 *   pnpm mail:verify path/to/mail.eml [--any-date]
 * --any-date skips the "signed Date is close to arrival" check, for mail saved earlier.
 * Prints only the verdict and signed header facts, never the body.
 */
import { readFile, stat } from 'node:fs/promises'
import { defaultTxtResolver, SENDERS, sha256Hex, verifyBankMail } from '@warren/core'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const owners = (process.env.WARREN_OWNER_ADDRESSES ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean)
if (!file || owners.length === 0) {
  console.error(
    'usage: WARREN_OWNER_ADDRESSES=you@example.com pnpm mail:verify <file.eml> [--any-date]',
  )
  process.exit(2)
}

const raw = new Uint8Array(await readFile(file))
const verdict = await verifyBankMail(raw, {
  senders: SENDERS,
  ownerAddresses: owners,
  resolver: defaultTxtResolver,
  receivedAt: (await stat(file)).mtime,
  maxDateSkewMinutes: args.includes('--any-date') ? null : 120,
})
const { keyRecord: _omitted, ...shown } = verdict as typeof verdict & { keyRecord?: string }
console.log(JSON.stringify({ sha256: sha256Hex(raw), bytes: raw.byteLength, ...shown }, null, 2))
process.exit(verdict.verdict === 'verified' ? 0 : 1)
