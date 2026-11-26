import { z } from 'zod'

const message = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.coerce.number().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  // A photo: only its media id (to download it), its type and its caption are read. The bytes are never stored.
  image: z
    .object({
      id: z.string(),
      mime_type: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  // A voice note: only its media id.
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  // The message this one replies to.
  context: z.object({ id: z.string().optional() }).optional(),
})

const status = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.coerce.number().optional(),
  errors: z
    .array(z.object({ code: z.number().optional(), title: z.string().optional() }))
    .optional(),
})

const payload = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                messages: z.array(z.unknown()).default([]),
                statuses: z.array(z.unknown()).default([]),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
})

/**
 * What the worker's queue needs of a message: who sent it, its kind, the text (or a photo's caption), the media id of a photo or voice note
 * (stored at ingest, to download it later) and the message it replied to. The raw payload is not kept.
 */
export interface InboundMessage {
  id: string
  from: string
  type: string
  timestamp?: number | undefined
  text: string | null
  mediaId: string | null
  contextId: string | null
}
export type StatusUpdate = z.infer<typeof status>

/** Pulls messages and status updates out of a webhook body. Entries that do not fit are skipped. */
export function parseWebhook(body: unknown): {
  messages: InboundMessage[]
  statuses: StatusUpdate[]
} {
  const out = { messages: [] as InboundMessage[], statuses: [] as StatusUpdate[] }
  const parsed = payload.safeParse(body)
  if (!parsed.success) return out
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const raw of change.value.messages) {
        const m = message.safeParse(raw)
        if (m.success) {
          const d = m.data
          out.messages.push({
            id: d.id,
            from: d.from,
            type: d.type,
            timestamp: d.timestamp,
            text: d.text?.body ?? d.image?.caption ?? null,
            mediaId: d.image?.id ?? d.audio?.id ?? null,
            contextId: d.context?.id ?? null,
          })
        }
      }
      for (const raw of change.value.statuses) {
        const s = status.safeParse(raw)
        if (s.success) out.statuses.push(s.data)
      }
    }
  }
  return out
}
