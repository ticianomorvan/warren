import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'

/** The browser's half of a sign-in: a random secret, httpOnly. The database keeps only its hash. */
export const LINK_COOKIE = 'warren_link'

/** What the plugin needs from the sign-in's own tables. */
export interface SessionLinks {
  /**
   * Spends the sign-in this browser secret belongs to, once: the id of the `account` that confirmed
   * on WhatsApp, or null when the secret matches nothing, nothing was confirmed, it expired or it was spent.
   */
  spend(secret: string): Promise<number | null>
}

/** `a<id>@users.invalid`: better-auth requires an email; no personal data goes in it. */
export const placeholderEmail = (accountId: number) => `a${accountId}@users.invalid`

/**
 * The one way into a session: `POST /api/auth/warren/link/complete`, called by the sign-in page once
 * WhatsApp confirmed. It finds or makes the `auth_user` of the confirmed account and sets the session
 * cookie. With the signed `oauth_query` in the body, better-auth's own hook then resumes the
 * authorization (consent page, or the client's redirect) in the same response.
 */
export const linkSession = (links: SessionLinks) =>
  ({
    id: 'warren-link',
    endpoints: {
      warrenLinkComplete: createAuthEndpoint(
        '/warren/link/complete',
        { method: 'POST', body: z.object({ oauth_query: z.string().min(1) }) },
        async (ctx) => {
          const secret = ctx.getCookie(LINK_COOKIE)
          const accountId = secret ? await links.spend(secret) : null
          if (accountId === null) throw new APIError('FORBIDDEN', { message: 'not_confirmed' })

          const { adapter, internalAdapter } = ctx.context
          const known = () =>
            adapter.findOne<{ id: string }>({
              model: 'user',
              where: [{ field: 'warrenAccountId', value: accountId }],
            })
          let user = await known()
          if (!user) {
            try {
              user = await internalAdapter.createUser(
                {
                  email: placeholderEmail(accountId),
                  name: 'Warren',
                  emailVerified: true,
                  warrenAccountId: accountId,
                },
                { method: 'warren-link' },
              )
            } catch (error) {
              // Two completions at once: the unique column let one in; the other reads it.
              user = await known()
              if (!user) throw error
            }
          }
          const session = await internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user: user as never })
          ctx.setCookie(LINK_COOKIE, '', { maxAge: 0, path: '/' })
          return ctx.json({ ok: true })
        },
      ),
    },
  }) satisfies BetterAuthPlugin
