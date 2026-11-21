import { createHmac } from 'node:crypto'

/** The app secret the spike's fake WhatsApp adapter is configured with (agent/channels/whatsapp.ts). */
export const APP_SECRET = 'spike-app-secret'
export const PHONE_NUMBER_ID = '123456789012345'

export interface Inbound {
  wamid: string
  from: string
  /** Unix seconds. */
  timestamp: number
  message:
    | { type: 'text'; text: { body: string } }
    | { type: 'image'; image: { id: string; mime_type: string; sha256: string; caption?: string } }
    | { type: 'audio'; audio: { id: string; mime_type: string; sha256: string; voice?: boolean } }
}

/** A Meta webhook body with one inbound message, in the shape Cloud API sends it. */
export function webhookBody(i: Inbound): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'spike-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Spike' }, wa_id: i.from }],
              messages: [
                { id: i.wamid, from: i.from, timestamp: String(i.timestamp), ...i.message },
              ],
            },
          },
        ],
      },
    ],
  })
}

export const signature = (raw: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`

/** Posts a signed webhook to the agent's WhatsApp route, like Meta does. */
export function postWebhook(base: string, raw: string) {
  return fetch(`${base}/eve/v1/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature(raw) },
    body: raw,
  })
}
