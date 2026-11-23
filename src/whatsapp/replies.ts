import type { MediaProblem } from './graph'

/** What the worker says on its own, with no model: the texts of the paths that are not a turn (a kind it cannot read, a media problem, a slow message, a failure). */

export const REPLY_NON_TEXT = 'Por ahora solo entiendo texto y fotos.'
/** A voice note when no transcription service is configured. */
export const REPLY_AUDIO = 'Todavía no entiendo audios. Escribime el gasto y lo anoto.'
/** What the person is told when a voice note cannot be used, by why. Not a failure of the message: code answers, no model. */
export const REPLY_VOICE = {
  too_large: 'El audio es muy largo para escucharlo. Mandalo más corto o escribime el gasto.',
  unsupported: 'No puedo leer ese tipo de audio. Mandame una nota de voz o escribime el gasto.',
  /** A download that failed, the transcription service down or too slow. */
  failed: 'No pude procesar el audio, ¿me lo escribís?',
  /** The confidence gate refused it: noise, silence, or too unsure to act on. */
  unclear: 'No te entendí el audio, ¿me lo escribís?',
} as const

/** What the person is told when a photo cannot be read, by why. */
export const REPLY_IMAGE: Record<MediaProblem, string> = {
  too_large:
    'La foto es muy pesada para leerla (máximo 5 MB). Mandala más liviana o escribime el gasto.',
  unsupported: 'Solo puedo leer fotos JPG, PNG o WebP. Mandala así o escribime el gasto.',
  unavailable: 'No pude descargar la foto. Mandala de nuevo o escribime el gasto.',
}

export const REPLY_INTERIM = 'Sigo con esto, ya te respondo.'
export const REPLY_FAILED = 'No pude procesar tu mensaje. Probá de nuevo en un rato.'
