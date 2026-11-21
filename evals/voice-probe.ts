import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranscriber, judgeTranscript } from '../src/transcribe'
import { checkAudio } from '../src/whatsapp/graph'

/**
 * Local probe: sends audio files to the real transcription service and prints the transcript, the
 * confidence numbers and the gate's verdict for each. For real voice notes, which are never committed:
 *
 *   pnpm tsx evals/voice-probe.ts /path/a.ogg /path/b.ogg
 *
 * Needs OPENROUTER_API_KEY in .env (read into the environment, never printed).
 */
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'))
} catch {}
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing: set it in .env')
const files = process.argv.slice(2)
if (files.length === 0) throw new Error('usage: tsx evals/voice-probe.ts <audio file>...')

const transcriber = createTranscriber({ apiKey })
for (const file of files) {
  const started = performance.now()
  const t = await transcriber.transcribe(checkAudio(readFileSync(file)))
  const ms = Math.round(performance.now() - started)
  const verdict = judgeTranscript(t)
  console.log(`\n${file.split('/').pop()}  ${ms} ms`)
  console.log(`  text:    ${JSON.stringify(t.text.trim())}`)
  for (const s of t.segments) {
    console.log(
      `  segment: avg_logprob ${s.avg_logprob.toFixed(2)}  compression_ratio ${s.compression_ratio.toFixed(2)}  no_speech_prob ${s.no_speech_prob.toFixed(3)}`,
    )
  }
  console.log(
    `  gate:    ${verdict.ok ? 'PASS' : `REFUSED (${verdict.reason}: ${verdict.detail})`}`,
  )
}
