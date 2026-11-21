#!/bin/sh
# Regenerates the synthetic voice notes the voice scenarios send (macOS: `say` and ffmpeg). They are
# computer voices reading the `text` of each scenario turn, never a real person: real notes are not
# committed. Opus in Ogg at 16 kHz mono, the way WhatsApp sends a voice note.
#   sh evals/scenarios/fixtures/make-voice.sh
set -eu
cd "$(dirname "$0")"

# say <file> <voice> <text>
speak() {
  say -v "$2" -o "$1.aiff" "$3"
  ffmpeg -loglevel error -y -i "$1.aiff" -ac 1 -ar 16000 -c:a libopus -b:a 24k -application voip "$1.ogg"
  rm "$1.aiff"
}

speak voice-gastos Paulina "Anotá café tres mil quinientos, súper ocho mil y nafta diez mil."
speak voice-correccion Mónica "No, el café fue tres mil ochocientos."
speak voice-consulta Paulina "¿Cuánto voy gastado este mes?"
speak voice-cafe Mónica "Café tres mil quinientos."
speak voice-correccion-dos Mónica "No, el café fue cuatro mil."
speak voice-ayer Mónica "Ayer veinte mil de nafta."
speak voice-ponele Paulina "A ese ponele tres mil quinientos."
speak voice-ese Mónica "Sí, ese mismo."

# Noise, not speech: three seconds of brown noise, then one of near silence.
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=color=brown:duration=3:amplitude=0.3:seed=7" \
  -ac 1 -ar 16000 -c:a libopus -b:a 24k -application voip voice-ruido.ogg
