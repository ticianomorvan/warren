import { defaultTxtResolver, type ResendWebhookDeps, SENDERS } from '@warren/core'
import { createTenancy } from '@warren/db'
import { database } from './db'
import { env } from './env'
import { rawStore } from './raw-store'

let cached: ResendWebhookDeps | undefined

export function resendWebhookDeps(): ResendWebhookDeps {
  if (cached) return cached
  cached = {
    tenancy: createTenancy(database(), rawStore()),
    resolver: defaultTxtResolver,
    senders: SENDERS,
    // Bank alerts are forwarded within seconds; anything older is a replay.
    maxDateSkewMinutes: 120,
    inboundDomain: env.inboundDomain(),
    webhookSecret: env.resendWebhookSecret(),
    apiKey: env.resendApiKey(),
  }
  return cached
}
