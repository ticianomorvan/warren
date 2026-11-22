import { judgeTranscript, type Transcriber, TranscriptionError } from '../transcribe'
import { type Graph, type Image, MediaError } from './graph'
import { REPLY_VOICE } from './replies'

/** The photo of a message, or why it cannot be read. Anything else (the deadline's abort) is thrown. */
export function fetchPhoto(
  graph: Graph,
  mediaId: string | null,
  signal: AbortSignal,
): Promise<{ image: Image } | { problem: MediaError }> {
  if (!mediaId) {
    return Promise.resolve({
      problem: new MediaError('unavailable', 'the webhook has no media id'),
    })
  }
  return graph.fetchImage(mediaId, signal).then(
    (image) => ({ image }),
    (error: unknown) => {
      if (error instanceof MediaError) return { problem: error }
      throw error
    },
  )
}

/** A voice note that could not be used, answered with `notice`; `cause` and `detail` go to the log and the audit, not to the person. */
export interface Unheard {
  notice: string
  cause: string
  detail: string
}

/**
 * The words of a voice note, or why they cannot be used: its download (the same limits as a photo's), the transcription and the
 * confidence gate. A failure is a notice, never silence; only the message's own deadline (the abort) is thrown.
 */
export async function hear(
  transcriber: Transcriber,
  graph: Graph,
  mediaId: string | null,
  signal: AbortSignal,
): Promise<{ heard: string } | Unheard> {
  if (!mediaId) {
    return {
      notice: REPLY_VOICE.failed,
      cause: 'unavailable',
      detail: 'the webhook has no media id',
    }
  }
  try {
    const audio = await graph.fetchAudio(mediaId, signal)
    const verdict = judgeTranscript(await transcriber.transcribe(audio, signal))
    if (verdict.ok) return { heard: verdict.text }
    return {
      notice: verdict.reason === 'too_long' ? REPLY_VOICE.too_large : REPLY_VOICE.unclear,
      cause: `refused ${verdict.reason}`,
      detail: verdict.detail,
    }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof MediaError) {
      const notice =
        error.problem === 'unavailable' ? REPLY_VOICE.failed : REPLY_VOICE[error.problem]
      return { notice, cause: error.problem, detail: error.message }
    }
    if (error instanceof TranscriptionError) {
      return { notice: REPLY_VOICE.failed, cause: error.failure, detail: error.message }
    }
    throw error
  }
}
