import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@warren/core', '@warren/db'],
  serverExternalPackages: ['mailauth', 'pg', 'linkedom', 'postal-mime'],
  poweredByHeader: false,
}

export default config
