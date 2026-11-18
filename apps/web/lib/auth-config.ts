import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type SignupPolicy } from '@warren/core'
import { authSchema } from '@warren/db'
import { APIError, betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { nextCookies } from 'better-auth/next-js'

export type AuthSettings = {
  /** A Drizzle database over the auth tables, connected as warren_auth. */
  db: Parameters<typeof drizzleAdapter>[0]
  secret: string
  baseURL: string
  /** Other origins that may call the auth routes (a preview's branch alias). */
  trustedOrigins?: string[]
  signup: SignupPolicy
  /**
   * Runs once a user exists, after their row is committed: makes the user's data key.
   * `asUser` makes it on first use too, so a failure here is not fatal.
   */
  onUserCreated: (userId: string) => Promise<void>
  /** Receives what Better Auth logs at warn level or above. Defaults to the console. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void
}

/** What every refusal to sign up says, whoever asks and whatever they ask with. */
const SIGNUP_CLOSED = { message: 'signup_closed' } as const

/**
 * The most a client address may try per window on the two routes that take a password or make an
 * account. Tighter than Better Auth's default for them (3 per 10 seconds is 18 a minute).
 */
const CREDENTIAL_ROUTE_LIMIT = { window: 60, max: 5 } as const

/**
 * Email and password only: no outbound mail exists yet, so no verification and no reset (the
 * operator sets a password with `pnpm user:set-password`). Ids come from the database, and
 * Better Auth's `account` is the table `auth_account` because the ledger has an `account`.
 */
export function createAuth(settings: AuthSettings) {
  // The session hook below reads the user through Better Auth's own adapter. It is not handed
  // one when a session is made outside a request, so it reaches for the instance once built.
  let users: { findUserById(id: string): Promise<unknown> } | undefined
  const instance = betterAuth({
    appName: 'Warren',
    baseURL: settings.baseURL,
    ...(settings.trustedOrigins ? { trustedOrigins: settings.trustedOrigins } : {}),
    secret: settings.secret,
    // `transaction: true`: the user row and its credential row are made together or not at all.
    // The `after` hook below runs once that transaction commits, which the data key needs.
    database: drizzleAdapter(settings.db, {
      provider: 'pg',
      schema: authSchema,
      transaction: true,
    }),
    account: { modelName: 'auth_account' },
    // Set by erasure, never by a client. Read by the session hook below.
    user: {
      additionalFields: { erasedAt: { type: 'date', required: false, input: false } },
    },
    advanced: { database: { generateId: false } },
    // Warn and above only: at info Better Auth logs "Sign-up attempt for existing email: <email>".
    logger: { level: 'warn', ...(settings.log ? { log: settings.log } : {}) },
    // In the database: on serverless every request may land on a new instance, so a counter in
    // memory counts nothing. The client address comes from `x-forwarded-for`, which Vercel sets.
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rate_limit',
      customRules: {
        '/sign-in/email': CREDENTIAL_ROUTE_LIMIT,
        '/sign-up/email': CREDENTIAL_ROUTE_LIMIT,
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    hooks: {
      // Before anything looks the email up: an unlisted email must get the same answer whether or
      // not an account has it, or sign-up tells a stranger who is registered (422 for a known
      // email, 403 for an unknown one). The hook on the user row below stays as the backstop.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return
        const email: unknown = ctx.body?.email
        if (typeof email !== 'string' || !settings.signup.allows(email)) {
          throw new APIError('FORBIDDEN', SIGNUP_CLOSED)
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The gate is on the row itself, so no route can create a user around it.
          before: async (user) => {
            if (!settings.signup.allows(user.email)) throw new APIError('FORBIDDEN', SIGNUP_CLOSED)
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
      session: {
        create: {
          // An erased user gets no session. Erasure deletes their credentials, so this is not
          // reachable by sign-in; it is here for any other way a session could be made. The
          // database refuses it too (trigger `session_not_for_erased_user`).
          before: async (session) => {
            // Typed without the additional field above, which the adapter does return.
            const found = (await users?.findUserById(session.userId)) as {
              erasedAt?: Date | null
            } | null
            if (found?.erasedAt) throw new APIError('FORBIDDEN', { message: 'account_erased' })
          },
        },
      },
    },
    plugins: [nextCookies()],
  })
  users = {
    findUserById: async (id) => (await instance.$context).internalAdapter.findUserById(id),
  }
  return instance
}

export type Auth = ReturnType<typeof createAuth>
