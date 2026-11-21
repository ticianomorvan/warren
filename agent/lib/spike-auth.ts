import { type AuthFn, withAuthChallenges } from 'eve/channels/auth'

/**
 * Stand-in route auth for the spike's HTTP and MCP channels: a shared secret in `x-warren-secret` and the
 * caller's wa_id in `x-warren-user`. Real auth (OAuth, signed tokens) is out of scope for the spike.
 */
export const spikeAuth: AuthFn<Request> = withAuthChallenges(
  (request) => {
    const user = request.headers.get('x-warren-user')
    if (!user || request.headers.get('x-warren-secret') !== process.env.SPIKE_SECRET) return null
    return {
      authenticator: 'spike',
      principalType: 'user' as const,
      principalId: user,
      attributes: {},
    }
  },
  [{ scheme: 'Bearer' }],
)
