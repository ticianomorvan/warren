import { defaultTxtResolver, type IntakeDeps, type ResendWebhookDeps, SENDERS } from '@warren/core'
import { createTenancy } from '@warren/db'
import { database } from './db'
import { env } from './env'
import { rawStore } from './raw-store'

let cachedIntake: IntakeDeps | undefined
let cached: ResendWebhookDeps | undefined

/** What checking mail needs, without the webhook's secrets: also used after a mailbox claim. */
export function intakeDeps(): IntakeDeps {
  cachedIntake ??= {
    tenancy: createTenancy(database(), rawStore()),
    resolver: defaultTxtResolver,
    senders: SENDERS,
    // Bank alerts are forwarded within seconds; anything older is a replay.
    maxDateSkewMinutes: 120,
    inboundDomain: env.inboundDomain(),
  }
  return cachedIntake
}

export function resendWebhookDeps(): ResendWebhookDeps {
  if (cached) return cached
  cached = {
    ...intakeDeps(),
    webhookSecret: env.resendWebhookSecret(),
    apiKey: env.resendApiKey(),
  }
  return cached
}
