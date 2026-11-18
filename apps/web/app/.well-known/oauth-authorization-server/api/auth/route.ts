import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * The same document at the RFC 8414 path for the issuer `https://<host>/api/auth`: the issuer
 * has a path, so a client that follows the spec looks here (the root route is the fallback).
 * Better Auth answers it itself, as it does the protected-resource documents.
 */
export const GET = (request: Request) => auth().handler(request)
