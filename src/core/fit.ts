/**
 * WhatsApp refuses a text body over 4,096 characters with a permanent error, and a reply that cannot be sent
 * after its changes were committed is a silent write. Replies stay under this, with room to spare.
 */
export const MAX_REPLY_CHARS = 4000

export const BULLET = '• '
/** `text` in at most `max` UTF-16 units (what WhatsApp's limit and `.length` count), ending in "…" when cut, never inside an emoji. */
const cut = (text: string, max: number) => {
  if (text.length <= max) return text
  let out = ''
  for (const char of text) {
    if (out.length + char.length > max - 1) break
    out += char
  }
  return `${out}…`
}

/**
 * The reply to send: what was heard (voice only, and only when `heard` is given), the record lines code rendered,
 * then the model's own words, one per line, held under `max` characters. When they do not fit, in this order: the
 * model's words go (they add nothing the record lacks), and long bulleted lists in the record are collapsed to
 * their first items and "• … y N más". A record is never dropped without saying so: lines that still do not fit
 * end as "… y N más", and a single line is cut with "…" as a last resort.
 */
export function fitReply(
  parts: { heard?: string; lines: string[]; notes: string[] },
  max = MAX_REPLY_CHARS,
): string {
  const join = (heard: string | undefined, lines: string[], notes: string[]) =>
    [...(heard === undefined ? [] : [renderHeard(heard)]), ...lines, ...notes].join('\n')
  const { heard } = parts
  let { notes } = parts
  const whole = () => join(heard, parts.lines, notes)
  if (whole().length <= max) return whole()

  notes = []
  if (whole().length <= max) return whole()

  // Collapse the longest bulleted list, one item at a time.
  const blocks = parts.lines.map((line) => line.split('\n'))
  const hidden = blocks.map(() => 0)
  const lines = () =>
    blocks.map((rows, k) =>
      [...rows, ...(hidden[k] ? [`${BULLET}… y ${hidden[k]} más`] : [])].join('\n'),
    )
  const items = (rows: string[]) => rows.filter((r) => r.startsWith(BULLET)).length
  for (;;) {
    if (join(heard, lines(), notes).length <= max) return join(heard, lines(), notes)
    let longest = -1
    for (const [k, rows] of blocks.entries()) {
      if (items(rows) > 1 && (longest < 0 || items(rows) > items(blocks[longest] ?? [])))
        longest = k
    }
    if (longest < 0) break
    const rows = blocks[longest] ?? []
    const last = rows.map((r) => r.startsWith(BULLET)).lastIndexOf(true)
    rows.splice(last, 1)
    hidden[longest] = (hidden[longest] ?? 0) + 1
  }
  // Still too long with nothing left to collapse: keep the first lines that fit and say how many more there are.
  const all = lines()
  for (let keep = all.length - 1; keep >= 1; keep--) {
    const text = join(heard, [...all.slice(0, keep), `… y ${all.length - keep} más`], notes)
    if (text.length <= max) return text
  }
  return cut(join(heard, all, notes), max)
}

/** The most of what was heard that the 🎙️ line shows. */
export const MAX_HEARD_CHARS = 80

/**
 * The first line of the reply to a voice note that changed nothing: what was heard, so that a mishearing shows
 * before the person answers it. When something was logged, corrected or deleted, the record shows what was
 * understood and this line is left out (`execute`).
 */
export const renderHeard = (transcript: string) => `🎙️ "${cut(transcript, MAX_HEARD_CHARS)}"`
