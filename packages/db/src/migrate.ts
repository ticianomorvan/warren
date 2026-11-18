import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

// Runs as the database owner over the direct (unpooled) URL. Never used by the deployed app.
const url = process.env.DATABASE_URL_MIGRATIONS
if (!url)
  throw new Error("Set DATABASE_URL_MIGRATIONS to the owner role's direct connection string")

const pool = new Pool({ connectionString: url, max: 1 })
await migrate(drizzle(pool), {
  migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
})
await pool.end()
console.log('migrations applied')
