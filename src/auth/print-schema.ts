// `pnpm tsx src/auth/print-schema.ts`: what better-auth would create for our config, as SQL, on an
// empty database. `012_auth.sql` is that output (tables `auth_*`) plus our own constraints; a test
// fails when better-auth wants a table or column the migration does not have.
import { getMigrations } from 'better-auth/db/migration'
import { createTestDatabase } from '../test-harness'
import { createAuth } from './config'

const db = await createTestDatabase({ max: 3 })
const auth = createAuth({
  sql: db.sql,
  publicUrl: 'https://example.test',
  secret: 'x'.repeat(40),
  links: { spend: async () => null },
})
const plan = await getMigrations(auth.options)
console.log(await plan.compileMigrations())
await db.close()
