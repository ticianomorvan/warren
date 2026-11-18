/**
 * Prints a new VAPID key pair for Web Push.  pnpm push:vapid-keys
 * Set the three values on Vercel (and in apps/web/.env.local for local work). Changing the
 * pair later breaks every existing subscription: people have to turn notifications on again.
 */
import { generateVapidKeys } from '@warren/core'

const { publicKey, privateKey } = generateVapidKeys()
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:you@example.com   # a contact for the push services')
