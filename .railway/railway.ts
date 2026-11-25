import { defineRailway, github, postgres, project, service, volume } from 'railway/iac'

/**
 * Both environments drain and overlap for 15 s. `staging` (created by hand once: `railway environment new staging`, empty)
 * gets its own Warren service, its own Postgres and the `graph-sink`.
 *
 * Variables are unmanaged, so no secret is in this file. Staging's secrets are set with `railway variables`:
 * fresh fake WhatsApp app secret, verify token and Graph token, a fresh BETTER_AUTH_SECRET, the real Anthropic and
 * transcription keys, and no REMINDER_TEMPLATE. Staging's ALLOWED_WA_IDS holds synthetic numbers only.
 */
export default defineRailway((ctx) => {
  const staging = ctx.isEnvironment('staging')

  const Postgres = postgres('Postgres', { region: 'us-east4-eqdc4a' })
  Postgres.deploy = { multiRegionConfig: { 'us-east4-eqdc4a': { numReplicas: 1 } } }
  Postgres.networking = { privateNetworkEndpoint: 'postgres', tcpProxies: { '5432': {} } }
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-east4-eqdc4a',
    sizeMB: staging ? 1000 : 5000,
  })

  const warren = service('warren', {
    ...(staging ? { source: github('ticianomorvan/warren', { branch: 'rebuild' }) } : {}),
    build: { buildEnvironment: 'V3', builder: 'RAILPACK' },
    start: 'pnpm start',
    healthcheck: '/health',
    healthcheckTimeout: 60,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // The old deploy keeps running 15 s after the new one is up, then gets SIGTERM and 15 s to finish its work.
      overlapSeconds: 15,
      drainingSeconds: 15,
    },
    replicas: { 'us-east4-eqdc4a': 1 },
    ...(staging ? {} : { domains: ['wa.heywarren.app'] }),
  })

  if (!staging) {
    return project('warren', {
      variables: { managed: false },
      resources: [Postgres, warren, postgresVolume],
    })
  }

  const sink = service('graph-sink', {
    source: github('ticianomorvan/warren', { branch: 'rebuild' }),
    build: { buildEnvironment: 'V3', builder: 'RAILPACK' },
    start: 'node scripts/graph-sink/server.ts',
    healthcheck: '/health',
    replicas: { 'us-east4-eqdc4a': 1 },
  })
  return project('warren', {
    variables: { managed: false },
    resources: [Postgres, warren, sink, postgresVolume],
  })
})
