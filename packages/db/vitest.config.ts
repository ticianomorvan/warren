import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each test file starts its own in-process Postgres and runs every migration in beforeAll;
    // on a two-core CI runner, with files in parallel, that can pass vitest's 10-second default.
    hookTimeout: 60_000,
  },
})
