import { type MasterKeys, masterKeysFromEnv } from '@warren/core'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

/** Read lazily, so a build without secrets still succeeds. */
export const env = {
  databaseUrl: () => required('DATABASE_URL'),
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
    const userId = process.env.WARREN_KAPSO_USER_ID
    if (!apiKey || !phoneNumberId || !to || !userId) return null
    const name = process.env.KAPSO_NOTICE_TEMPLATE
    const language = process.env.KAPSO_NOTICE_TEMPLATE_LANGUAGE ?? 'es_AR'
    return { apiKey, phoneNumberId, to, userId, template: name ? { name, language } : undefined }
  },
  kapsoWebhookSecret: () => required('KAPSO_WEBHOOK_SECRET'),
}
