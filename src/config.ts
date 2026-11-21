import { z } from 'zod'

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  )

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  // Empty means every sender is answered (dev mode). Set it to restrict replies.
  ALLOWED_WA_IDS: list,
})

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
