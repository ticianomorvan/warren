import { defineRailway, postgres, project, service, volume } from 'railway/iac'

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
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: { 'us-east4-eqdc4a': 1 },
    domains: ['wa.heywarren.app'],
  })

  return project('warren', {
    variables: { managed: false },
    resources: [Postgres, warren, postgresVolume],
  })
})
