import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withClaude } from '../auth-test-kit'
import { useDatabase } from '../test-harness'
import { renderMarkdown } from './markdown'

/** The agent-readable web: every document has a page for people and a Markdown twin for agents, and `/llms.txt` indexes them. */
useDatabase()

let app: Awaited<ReturnType<typeof withClaude>>['app']
beforeAll(async () => {
  ;({ app } = await withClaude())
})
afterAll(() => {
  app.close()
})

const get = (path: string, accept?: string) =>
  fetch(`${app.base}${path}`, { headers: accept ? { accept } : {} })

describe('/setup.md', () => {
  it('is Markdown with the exact setup of each client, naming this server’s own URL', async () => {
    const res = await get('/setup.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/)
    const md = await res.text()
    const mcp = `${app.base}/mcp`
    expect(md).toContain(`claude mcp add --transport http warren ${mcp}`)
    expect(md).toContain('Claude on the web, desktop and mobile')
    expect(md).toContain(
      `name=warren&config=${Buffer.from(JSON.stringify({ url: mcp })).toString('base64')}`,
    )
    expect(md).toContain(`code --add-mcp '{"name":"warren","type":"http","url":"${mcp}"}'`)
    expect(md).toContain('ChatGPT')
    expect(md).toContain('Any other MCP client')
    expect(md).toContain('ledger:read')
    expect(md).toContain('offline_access')
    expect(md).toContain(`${app.base}/.well-known/oauth-protected-resource/mcp`)
    // What an agent may not hold: no token, and nothing that says it can sign the person in for them.
    expect(md).toContain('the person taps')
    expect(md).not.toMatch(/whatsapp/i)
  })
})

describe('/llms.txt', () => {
  it('indexes the documents, and every link in it answers', async () => {
    const res = await get('/llms.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    const text = await res.text()
    expect(text).toMatch(/^# Warren/)
    const links = [...text.matchAll(/\]\((http[^)]+)\)/g)].map((m) => m[1] as string)
    for (const path of ['/setup.md', '/privacy.md', '/terms.md']) {
      expect(links).toContain(`${app.base}${path}`)
    }
    for (const link of links.filter((l) => l.startsWith(app.base))) {
      expect((await fetch(link)).status, link).toBe(200)
    }
  })
})

describe('the landing and its twin', () => {
  it('is a short Spanish page for people, with the way in for an agent', async () => {
    const res = await get('/', 'text/html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(res.headers.get('vary')).toMatch(/Accept/i)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('<h1>Warren</h1>')
    expect(html).toContain(`Configurá Warren desde ${app.base}`)
    expect(html).toContain('href="/privacy"')
    expect(html).not.toMatch(/<script/)
    expect(html).not.toMatch(/whatsapp/i)
    expect(html).not.toContain('noindex')
  })

  it('answers `Accept: text/markdown` on / with the Markdown of the same page', async () => {
    const res = await get('/', 'text/markdown')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(res.headers.get('vary')).toMatch(/Accept/i)
    const md = await res.text()
    expect(md).toMatch(/^# Warren/)
    expect(md).toContain(`${app.base}/setup.md`)
    // An agent's usual header, Markdown first with HTML as a fallback.
    const agent = await get('/', 'text/markdown, text/html;q=0.5')
    expect(agent.headers.get('content-type')).toMatch(/^text\/markdown/)
    // A browser prefers HTML, whatever else it lists.
    const browser = await get('/', 'text/html,application/xhtml+xml,text/markdown;q=0.1,*/*;q=0.8')
    expect(browser.headers.get('content-type')).toMatch(/^text\/html/)
    expect((await get('/index.md')).headers.get('content-type')).toMatch(/^text\/markdown/)
  })
})

describe.each(['privacy', 'terms'])('/%s', (name) => {
  it('is a page with a Markdown twin that says the same, honest about who runs it', async () => {
    const page = await get(`/${name}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)
    const html = await page.text()
    const twin = await get(`/${name}.md`)
    expect(twin.status).toBe(200)
    expect(twin.headers.get('content-type')).toMatch(/^text\/markdown/)
    const md = await twin.text()
    expect(md.split('\n')[0]).toBe(
      name === 'privacy' ? '# Política de privacidad' : '# Términos de uso',
    )
    expect(html).toContain(md.split('\n')[0]?.slice(2) ?? 'missing')
    // A free personal project: no company is named, no address, no lawyer's phrases about a legal entity.
    expect(md).toContain('proyecto personal y gratuito')
    expect(md).not.toMatch(/S\.A\.|S\.R\.L|Inc\.|LLC|Ltd/)
    expect(md).not.toMatch(/whatsapp/i)
    // Both are reachable from the account page and from Google's consent screen on our own host.
    expect(md).toContain(`${app.base}/account`)
  })
})

describe('what is not a document', () => {
  it('answers nothing else, and nothing but GET', async () => {
    expect((await get('/robots.txt')).status).toBe(404)
    expect((await fetch(`${app.base}/setup.md`, { method: 'POST' })).status).toBe(404)
  })
})

describe('renderMarkdown', () => {
  it('renders the subset the documents use, and escapes everything else', () => {
    expect(renderMarkdown('# T\n\nuna **marca** y `code <b>` y [a](/x)\n\n- uno\n- dos')).toBe(
      '<h1>T</h1>\n<p>una <strong>marca</strong> y <code>code &#60;b&#62;</code> y <a href="/x">a</a></p>\n<ul><li>uno</li><li>dos</li></ul>',
    )
    expect(renderMarkdown('```sh\nx <y>\n```')).toBe('<pre><code>x &#60;y&#62;</code></pre>')
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>',
    )
    // A link that is not http(s), a path or an anchor stays text.
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a')
  })
})
