// The hasher Better Auth signs in with. The operator script hashes with it too, so a password
// set by script opens the normal sign-in; the script lives outside this package's dependencies.
export { hashPassword } from 'better-auth/crypto'
