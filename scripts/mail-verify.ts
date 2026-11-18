/**
 * Checks a saved mail file against the bank sender policy, using live DNS.
 *   pnpm mail:verify path/to/mail.eml --mailbox you@example.com [--any-date]
 * --mailbox is the address the signed To header must name (repeat it for several).
 * --any-date skips the "signed Date is close to arrival" check, for mail saved earlier.
 * Prints only the verdict and signed header facts, never the body.
 */
import { readFile, stat } from 'node:fs/promises'
import { defaultTxtResolver, SENDERS, sha256Hex, verifyBankMail } from '@warren/core'

const args = process.argv.slice(2)
const mailboxes = args.flatMap((a, i) =>
  a === '--mailbox' && args[i + 1] ? [args[i + 1] as string] : [],
)
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--mailbox')
if (!file || mailboxes.length === 0) {
  console.error('usage: pnpm mail:verify <file.eml> --mailbox you@example.com [--any-date]')
  process.exit(2)
}

const raw = new Uint8Array(await readFile(file))
const verdict = await verifyBankMail(raw, {
  senders: SENDERS,
  mailboxes,
  resolver: defaultTxtResolver,
  receivedAt: (await stat(file)).mtime,
  maxDateSkewMinutes: args.includes('--any-date') ? null : 120,
})
const { keyRecord: _omitted, ...shown } = verdict as typeof verdict & { keyRecord?: string }
console.log(JSON.stringify({ sha256: sha256Hex(raw), bytes: raw.byteLength, ...shown }, null, 2))
process.exit(verdict.verdict === 'verified' ? 0 : 1)
