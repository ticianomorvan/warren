/**
 * Gives a user a password, or replaces theirs.  pnpm user:set-password --user <id>
 * Until a reset mail exists (slice 6), this is how the user created by hand at the reset, and
 * anyone who forgot, gets one. The password is read from stdin and never from an argument, so it
 * is not in the process list or the shell history, and it is never printed:
 *   pnpm user:set-password --user <id>                # asks, with no echo
 *   pass show warren | pnpm user:set-password --user <id>   # or pipe it in
 * It hashes with Better Auth's own hasher, stores only the hash through warren_auth
 * (DATABASE_URL_AUTH), and ends the user's open sessions. It needs no master key. An erased user
 * gets no password.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@warren/core'
import { setCredentialPassword } from '@warren/db'
import { hashPassword } from 'better-auth/crypto'
import { connectKeyless, die, userArg } from './lib'

const user = userArg()

/** One line from a terminal without echoing it, or all of a pipe. */
async function readPassword(): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '')
  }
  process.stderr.write('New password (not shown): ')
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let line = ''
  return new Promise((resolve) => {
    stdin.on('data', function onData(char: string) {
      for (const c of char) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          return resolve(line)
        }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f' || c === '\b') line = line.slice(0, -1)
        else line += c
      }
    })
  })
}

const password = await readPassword()
if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  die(`The password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`)
}
const { pool, database } = connectKeyless('DATABASE_URL_AUTH')
const result = await setCredentialPassword(database, user, await hashPassword(password))
await pool.end()
if (result === 'no-user') die('No user with that id.')
if (result === 'erased') die('That user was erased; they cannot have a password.')
console.log('Password set. Open sessions of that user were ended.')
