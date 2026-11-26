import { z } from 'zod'

/** A variable that may be unset or blank; when set it must pass `schema`. */
const optional = (schema: z.ZodString) =>
  z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined)
    .pipe(schema.optional())

const fields = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  // The sign-in, the OAuth server for MCP and `/mcp` (docs/design.md, "Auth"). `PUBLIC_URL` turns them on and makes the other three
  // required. Unset, none of those routes exist and none of the three is read.
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
  BETTER_AUTH_SECRET: optional(z.string().min(32)),
  // The OAuth client of "Continuar con Google": Google Cloud console, Credentials, with `${PUBLIC_URL}/api/auth/callback/google`
  // as its redirect URI.
  GOOGLE_CLIENT_ID: optional(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optional(z.string().min(1)),
})

const schema = fields
  .superRefine((c, ctx) => {
    if (!c.PUBLIC_URL) return
    for (const name of [
      'BETTER_AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ] as const) {
      if (!c[name])
        ctx.addIssue({ code: 'custom', path: [name], message: 'required with PUBLIC_URL' })
    }
  })
  // The sign-in and OAuth server's settings, whole or absent: what the check above guarantees, as a type.
  .transform((c) => ({
    ...c,
    auth:
      c.PUBLIC_URL && c.BETTER_AUTH_SECRET && c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET
        ? {
            publicUrl: c.PUBLIC_URL,
            secret: c.BETTER_AUTH_SECRET,
            google: { clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET },
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
