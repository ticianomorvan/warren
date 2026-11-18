import { defaultTxtResolver, type ResendWebhookDeps, SENDERS } from '@warren/core'
import { createLedger, createMailLog } from '@warren/db'
import { db } from './db'
import { env } from './env'
import { rawStore } from './raw-store'

let cached: ResendWebhookDeps | undefined

export function resendWebhookDeps(): ResendWebhookDeps {
  if (cached) return cached
  cached = {
    store: rawStore(),
    log: createMailLog(db()),
    ledger: createLedger(db()),
    resolver: defaultTxtResolver,
    senders: SENDERS,
    ownerAddresses: env.ownerAddresses(),
    // Bank alerts are forwarded within seconds; anything older is a replay.
    maxDateSkewMinutes: 120,
    webhookSecret: env.resendWebhookSecret(),
    apiKey: env.resendApiKey(),
  }
  return cached
}
