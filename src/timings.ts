/**
 * Where the time of one message goes, stored on `wa_message.timings` when its reply is sent and
 * read by `pnpm latency`. Every value is whole milliseconds. The stages run in this order, and what
 * is left of received -> reply sent after them is "other" (the webhook insert, the lane wait, the
 * interim note's close, the final write).
 */
export interface TurnTiming {
  /** The model call alone (the SDK's request, retries included). */
  model_ms: number
  /** The `find_movements` reads the turn ran after the call. */
  find_ms: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  /** Of those, the tokens written with the 1-hour TTL. */
  cache_write_1h?: number
  /** Characters of text the model wrote beside its tool calls (0 when it only called tools). */
  text_chars: number
}

export interface Timings {
  /** Received -> claimed (database clock). */
  claimed_ms: number
  /** The account, the 10 newest movements and the conversation window. */
  reads_ms?: number
  /** A photo's download or a voice note's transcription, awaited after the reads. */
  media_ms?: number
  /** The agent loop as a whole (model calls and the reads between them). */
  model_ms?: number
  /** One entry per model call. Empty when no model ran. */
  turns?: TurnTiming[]
  /** The commit transaction. */
  commit_ms?: number
  /** The `send_started_at` write that comes before the Graph call. */
  stamp_ms?: number
  /** The Graph send, until it answers. */
  send_ms?: number
}
