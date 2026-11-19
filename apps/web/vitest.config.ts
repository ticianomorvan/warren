import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The app's own `@/` imports, as tsconfig `paths` says.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // tsconfig keeps JSX for Next; the tests that render a component need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Each OAuth and MCP test file starts its own in-process Postgres and runs every migration
    // in beforeAll; on a two-core CI runner, with files in parallel, that takes over 10 seconds.
    hookTimeout: 60_000,
  },
})
