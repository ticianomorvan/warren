/**
 * Who may create ledger entries by mail. A mail counts only when the bank's own DKIM
 * signature covers the headers listed here. Changing this file is a pull-request-only change.
 */
export type SenderPolicy = {
  id: string
  /** Exact From addresses, lower case. */
  fromAddresses: readonly string[]
  /** Exact DKIM d= values. Other signatures on the mail (e.g. amazonses.com) are ignored. */
  allowedSigners: readonly string[]
  /** Lower-case header names the accepted signature must cover. */
  requiredSignedHeaders: readonly string[]
  minKeyBits: number
}

/** Bump when a policy below changes, so stored verdicts say which rules produced them. */
export const SENDER_POLICY_VERSION = 1

export const SENDERS: readonly SenderPolicy[] = [
  {
    // Card purchases ("Compra aprobada"), sent through Amazon SES.
    id: 'bbva-cards',
    fromAddresses: ['avisos-bbva-ar@bbva.com'],
    allowedSigners: ['bbva.com'],
    requiredSignedHeaders: ['from', 'to', 'date', 'subject'],
    minKeyBits: 1024,
  },
  {
    // Transfers sent and received. This sender does not sign Message-ID.
    id: 'bbva-transfers',
    fromAddresses: ['avisos@bbva.com.ar'],
    allowedSigners: ['bbva.com.ar'],
    requiredSignedHeaders: ['from', 'to', 'date', 'subject'],
    minKeyBits: 1024,
  },
]
