/**
 * The small subset of Markdown the web's own documents use (`content.ts`): headings, paragraphs, bullet and numbered lists, fenced
 * code, and inline code, bold and links. Everything else is escaped text. Hand-rolled because the documents are ours and a
 * dependency would add more than these forty lines; it never emits a tag the subset does not name, and it escapes first.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Inline: code spans first (their text is literal), then bold and links on what is left. Links keep only http(s), `/` and `#` targets. */
function inline(text: string): string {
  const parts = text.split(/(`[^`]+`)/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
          const target = href.replace(/&#38;/g, '&')
          return /^(https?:\/\/|\/|#)/.test(target)
            ? `<a href="${esc(target)}">${label}</a>`
            : whole
        })
    })
    .join('')
}

export function renderMarkdown(md: string): string {
  const out: string[] = []
  const lines = md.split('\n')
  let i = 0
  const flush = (para: string[]) => {
    if (para.length > 0) out.push(`<p>${inline(para.join(' '))}</p>`)
    para.length = 0
  }
  const para: string[] = []
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) {
      flush(para)
      const code: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '')
      i += 1
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line)
    if (heading) {
      flush(para)
      const level = (heading[1] as string).length
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`)
      i += 1
      continue
    }
    const bullet = /^- (.+)$/.exec(line)
    if (bullet) {
      flush(para)
      const items: string[] = []
      while (i < lines.length && /^- /.test(lines[i] ?? '')) items.push((lines[i++] ?? '').slice(2))
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`)
      continue
    }
    const numbered = /^\d+\. (.+)$/.exec(line)
    if (numbered) {
      flush(para)
      const items: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
        items.push((lines[i++] ?? '').replace(/^\d+\. /, ''))
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`)
      continue
    }
    if (line.trim() === '') {
      flush(para)
      i += 1
      continue
    }
    para.push(line)
    i += 1
  }
  flush(para)
  return out.join('\n')
}
