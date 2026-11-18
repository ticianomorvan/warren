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
  ownerAddresses: () =>
    required('WARREN_OWNER_ADDRESSES')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  /** The WhatsApp channel, or null while any of its three settings is missing. */
  kapso: () => {
    const apiKey = process.env.KAPSO_API_KEY
    const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID
    const to = process.env.WARREN_OWNER_WHATSAPP?.replace(/\D/g, '')
    if (!apiKey || !phoneNumberId || !to) return null
    const name = process.env.KAPSO_NOTICE_TEMPLATE
    const language = process.env.KAPSO_NOTICE_TEMPLATE_LANGUAGE ?? 'es_AR'
    return { apiKey, phoneNumberId, to, template: name ? { name, language } : undefined }
  },
  kapsoWebhookSecret: () => required('KAPSO_WEBHOOK_SECRET'),
}
