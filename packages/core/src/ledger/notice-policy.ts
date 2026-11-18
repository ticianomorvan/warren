/** A notice older than this is no longer worth sending, and mail older than this is not news. */
export const NOTICE_MAX_AGE_HOURS = 24

/**
 * Whether a movement made from mail received at `receivedAt` is still news. The outbox sends a
 * notice younger than `NOTICE_MAX_AGE_HOURS` (counted from the notice's creation) as if it were
 * fresh, so a movement made now from older mail must be created without one. Used by every path
 * that records mail the user did not just receive: replaying unrouted mail, recording parsed mail
 * that never became a movement.
 */
export const isNews = (receivedAt: Date, now: Date): boolean =>
  now.getTime() - receivedAt.getTime() < NOTICE_MAX_AGE_HOURS * 3_600_000
