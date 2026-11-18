import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type SignupPolicy } from '@warren/core'
import { authSchema } from '@warren/db'
import { APIError, betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'

export type AuthSettings = {
  /** A Drizzle database over the four auth tables, connected as warren_auth. */
  db: Parameters<typeof drizzleAdapter>[0]
  secret: string
  baseURL: string
  signup: SignupPolicy
  /**
   * Runs once a user exists, after their row is committed: makes the user's data key.
   * `asUser` makes it on first use too, so a failure here is not fatal.
   */
  onUserCreated: (userId: string) => Promise<void>
}

/**
 * Email and password only: no outbound mail exists yet, so no verification and no reset (the
 * operator sets a password with `pnpm user:set-password`). Ids come from the database, and
 * Better Auth's `account` is the table `auth_account` because the ledger has an `account`.
 */
export function createAuth(settings: AuthSettings) {
  return betterAuth({
    appName: 'Warren',
    baseURL: settings.baseURL,
    secret: settings.secret,
    database: drizzleAdapter(settings.db, { provider: 'pg', schema: authSchema }),
    account: { modelName: 'auth_account' },
    advanced: { database: { generateId: false } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    databaseHooks: {
      user: {
        create: {
          // The gate is on the row itself, so no route can create a user around it.
          before: async (user) => {
            if (!settings.signup.allows(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'signup_closed' })
            }
          },
          after: async (user) => {
            try {
              await settings.onUserCreated(user.id)
            } catch {
              // The account exists; `asUser` makes the key on first use. Log the class only.
              console.error('data key not created at sign-up; asUser will create it')
            }
          },
        },
      },
    },
    plugins: [nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>
