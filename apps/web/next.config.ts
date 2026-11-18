import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@warren/core', '@warren/db'],
  serverExternalPackages: ['mailauth', 'pg', 'linkedom', 'postal-mime'],
  poweredByHeader: false,
  async headers() {
    // The sign-in and consent pages decide who may act for a person: nobody may frame them.
    const noFraming = [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }]
    return [
      { source: '/oauth/:path*', headers: noFraming },
      { source: '/sign-in', headers: noFraming },
      { source: '/sign-up', headers: noFraming },
      {
        // The browser must always ask for the service worker, or an update could wait for days.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
    ]
  },
}

export default config
