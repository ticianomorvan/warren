import { inboundDomain, type MasterKeys, masterKeysFromEnv } from '@warren/core'
import { type AuthOrigins, authOrigins } from './auth-origin'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

/** Read lazily, so a build without secrets still succeeds. */
export const env = {
  databaseUrl: () => required('DATABASE_URL'),
  /** Better Auth connects as warren_auth: grants on the auth tables and nothing else. */
  databaseUrlAuth: () => required('DATABASE_URL_AUTH'),
  /** Signs and encrypts what Better Auth stores in cookies: 32+ random characters. */
  authSecret: () => required('BETTER_AUTH_SECRET'),
  /**
   * The public origin of the app, e.g. https://warren.example (`BETTER_AUTH_URL`), or on a Vercel
   * preview the deployment's own host. Decides the cookie names. See auth-origin.ts.
   */
  authOrigins: (): AuthOrigins => authOrigins(process.env),
  /** Who may sign up: emails separated by commas. Unset means nobody (see core/signup.ts). */
  signupEmails: () => process.env.WARREN_SIGNUP_EMAILS,
  /** The domain of users' own inbound addresses; defaults to in.heywarren.app. */
  inboundDomain: () => inboundDomain(process.env.WARREN_INBOUND_DOMAIN),
  resendApiKey: () => required('RESEND_API_KEY'),
  resendWebhookSecret: () => required('RESEND_WEBHOOK_SECRET'),
  /** Wraps each user's data key (see packages/core/src/crypto). */
  masterKeys: (): MasterKeys => masterKeysFromEnv(process.env),
  /**
   * Web Push (VAPID): `pnpm push:vapid-keys` makes the pair. The public key also goes to the
   * browser, so a person can subscribe. Null while any of the three is missing: the app runs,
   * and the notifications card says they are not set up.
   */
  vapid: () => {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
    const subject = process.env.VAPID_SUBJECT?.trim()
    if (!publicKey || !privateKey || !subject) return null
    if (!/^(mailto:|https:\/\/)/.test(subject)) {
      throw new Error('VAPID_SUBJECT must be a mailto: or https: URL')
    }
    return { publicKey, privateKey, subject }
  },
}
