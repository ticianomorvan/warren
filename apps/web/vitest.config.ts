import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each OAuth and MCP test file starts its own in-process Postgres and runs every migration
    // in beforeAll; on a two-core CI runner, with files in parallel, that takes over 10 seconds.
    hookTimeout: 60_000,
  },
})
