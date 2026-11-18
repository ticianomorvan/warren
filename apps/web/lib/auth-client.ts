'use client'

import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/react'

/**
 * Talks to /api/auth on the same origin. `oauthProviderClient` sends the signed authorization
 * query that /sign-in and /oauth/consent were opened with, so a sign-in or a consent made in the
 * middle of an agent's connection returns to that connection.
 */
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] })
