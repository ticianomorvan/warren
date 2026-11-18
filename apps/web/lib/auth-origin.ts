/**
 * The origin Better Auth serves from, and the other origins it trusts. It checks every sign-in
 * request's `Origin` against these, and the cookie's `Secure` flag follows the scheme.
 *
 * Production and local work use `BETTER_AUTH_URL`. A Vercel preview has a new origin per
 * deployment, so one fixed URL would refuse every preview: there the deployment's own host
 * (`VERCEL_URL`) is the base, and the branch alias (`VERCEL_BRANCH_URL`), which people open
 * instead of the per-deployment host, is trusted too.
 */
export type AuthOrigins = { baseURL: string; trustedOrigins: string[] }

type Env = Record<string, string | undefined>

export function authOrigins(env: Env): AuthOrigins {
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_URL) {
    const branch = env.VERCEL_BRANCH_URL
    return {
      baseURL: `https://${env.VERCEL_URL}`,
      trustedOrigins: branch && branch !== env.VERCEL_URL ? [`https://${branch}`] : [],
    }
  }
  const baseURL = env.BETTER_AUTH_URL
  if (!baseURL) throw new Error('Missing environment variable BETTER_AUTH_URL')
  return { baseURL, trustedOrigins: [] }
}
