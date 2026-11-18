import { canonicalUserId, type MasterKeys, masterKeysFromEnv } from '@warren/core'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

/** Read lazily, so a build without secrets still succeeds. */
export const env = {
  databaseUrl: () => required('DATABASE_URL'),
  /** Better Auth connects as warren_auth: grants on the four auth tables and nothing else. */
  databaseUrlAuth: () => required('DATABASE_URL_AUTH'),
  /** Signs and encrypts what Better Auth stores in cookies: 32+ random characters. */
  authSecret: () => required('BETTER_AUTH_SECRET'),
  /** The public origin of the app, e.g. https://warren.example. Decides the cookie names. */
  authUrl: () => required('BETTER_AUTH_URL'),
  /** Who may sign up: emails separated by commas. Unset means nobody (see core/signup.ts). */
  signupEmails: () => process.env.WARREN_SIGNUP_EMAILS,
  resendApiKey: () => required('RESEND_API_KEY'),
  resendWebhookSecret: () => required('RESEND_WEBHOOK_SECRET'),
  /** Wraps each user's data key (see packages/core/src/crypto). */
  masterKeys: (): MasterKeys => masterKeysFromEnv(process.env),
  /**
   * The legacy WhatsApp channel (slice 3 deletes it), or null while any of its settings is
   * missing. It reaches one number, so it serves one user: `userId`. Other users' notices wait
   * for push.
   */
  kapso: () => {
    const apiKey = process.env.KAPSO_API_KEY
    const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID
    const to = process.env.WARREN_OWNER_WHATSAPP?.replace(/\D/g, '')
    const configured = process.env.WARREN_KAPSO_USER_ID?.trim()
    if (!apiKey || !phoneNumberId || !to || !configured) return null
    // Compared with ids Postgres prints, so one spelling: lower case.
    let userId: string
    try {
      userId = canonicalUserId(configured)
    } catch {
      throw new Error('WARREN_KAPSO_USER_ID must be a uuid')
    }
    const name = process.env.KAPSO_NOTICE_TEMPLATE
    const language = process.env.KAPSO_NOTICE_TEMPLATE_LANGUAGE ?? 'es_AR'
    return { apiKey, phoneNumberId, to, userId, template: name ? { name, language } : undefined }
  },
  kapsoWebhookSecret: () => required('KAPSO_WEBHOOK_SECRET'),
}
