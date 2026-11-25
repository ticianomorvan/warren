import { defineRailway, postgres, project, service, volume } from 'railway/iac'

/**
 * One environment, `production`. Variables are unmanaged, so no secret is in this file; they are set with `railway variables`.
 * A staging environment (its own service and Postgres, plus a stand-in for Meta's Graph API) existed for the rebuild and was
 * deleted on 2026-11-25; git history has it (scripts/graph-sink, the probe's staging mode).
 */
export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: 'us-east4-eqdc4a' })
  Postgres.deploy = { multiRegionConfig: { 'us-east4-eqdc4a': { numReplicas: 1 } } }
  Postgres.networking = { privateNetworkEndpoint: 'postgres', tcpProxies: { '5432': {} } }
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-east4-eqdc4a',
    sizeMB: 5000,
  })

  const warren = service('warren', {
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
    domains: ['wa.heywarren.app'],
  })

  return project('warren', {
    variables: { managed: false },
    resources: [Postgres, warren, postgresVolume],
  })
})
