import { z } from 'zod'

/** `+54 9 11 ...` and `549 11 ...` are the same id. `*` is kept as it is. */
export const normalizeId = (s: string) => (s.trim() === '*' ? '*' : s.replace(/[^0-9]/g, ''))

const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map(normalizeId).filter(Boolean))

/**
 * The name of the approved WhatsApp template that carries a reminder outside the 24 h window (`warren_reminder`,
 * language es_AR; docs/design.md, "Reminders"). Unset, Warren sends no template: a reminder that needs one is logged and
 * marked failed. The server and the reminder scripts read it the same way.
 */
export const reminderTemplate = z
  .string()
  .optional()
  .transform((s) => s?.trim() || undefined)
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9_]{1,512}$/)
      .optional(),
  )

const fields = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  // Where Graph calls go. Unset, Meta's. Staging points it at the graph-sink so it never messages a real phone.
  GRAPH_BASE_URL: z
    .string()
    .optional()
    .transform((s) => s?.trim().replace(/\/$/, '') || undefined)
    .pipe(
      z
        .url()
        .refine((u) => new URL(u).pathname === '/', 'GRAPH_BASE_URL is an origin: no path')
        .optional(),
    ),
  // Comma-separated WhatsApp ids that get a reply. `*` answers everyone (dev mode). Empty or unset
  // answers nobody: messages are still stored, as `ignored`.
  ALLOWED_WA_IDS: list,
  ANTHROPIC_API_KEY: z.string().min(1),
  // Voice notes are transcribed through OpenRouter. Unset, a voice note is answered with a request for text.
  OPENROUTER_API_KEY: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
  // A human contact line for "ayuda" (Meta's messaging policy asks for one). No default.
  HELP_CONTACT: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
  REMINDER_TEMPLATE: reminderTemplate,
  // The sign-in and OAuth server for MCP (docs/design.md, "MCP and auth"). `PUBLIC_URL` turns it on and makes the other two
  // required. Unset, none of its routes exist and none of the three is read.
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((s) => s?.trim().replace(/\/$/, '') || undefined)
    .pipe(
      z
        .string()
        .regex(/^https:\/\/[^/]+$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/)
        .optional(),
    ),
  BETTER_AUTH_SECRET: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined)
    .pipe(z.string().min(32).optional()),
  // The number people message, as they read it ("+54 9 11 1234-5678"); its digits make the `wa.me` link.
  WHATSAPP_DISPLAY_NUMBER: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined)
    .pipe(
      z
        .string()
        .regex(/^\+?\d[\d\s().-]{6,}$/)
        .optional(),
    ),
})

const schema = fields
  .superRefine((c, ctx) => {
    if (!c.PUBLIC_URL) return
    for (const name of ['BETTER_AUTH_SECRET', 'WHATSAPP_DISPLAY_NUMBER'] as const) {
      if (!c[name])
        ctx.addIssue({ code: 'custom', path: [name], message: 'required with PUBLIC_URL' })
    }
  })
  // The sign-in and OAuth server's settings, whole or absent: what the check above guarantees, as a type.
  .transform((c) => ({
    ...c,
    auth:
      c.PUBLIC_URL && c.BETTER_AUTH_SECRET && c.WHATSAPP_DISPLAY_NUMBER
        ? {
            publicUrl: c.PUBLIC_URL,
            secret: c.BETTER_AUTH_SECRET,
            displayNumber: c.WHATSAPP_DISPLAY_NUMBER,
          }
        : undefined,
  }))

export type Config = z.infer<typeof schema>

/** Validates the environment. Reports only the names of bad variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))]
    throw new Error(`Invalid environment: ${names.join(', ')}`)
  }
  return parsed.data
}
