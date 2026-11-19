import { describe, expect, it } from 'vitest'
import { gmailFilterXml, gmailFromQuery, SENDERS } from '../src'

const ADDRESS = 'u-abcdefghijklmnopqrstuv@in.heywarren.app'
const xml = gmailFilterXml(ADDRESS, new Date('2026-11-19T12:00:00Z'))

describe('gmailFilterXml', () => {
  it('has Gmail filter-feed shape, with the property names gmailctl exports', () => {
    expect(xml).toContain('xmlns="http://www.w3.org/2005/Atom"')
    expect(xml).toContain('xmlns:apps="http://schemas.google.com/apps/2006"')
    expect(xml.match(/<entry>/g)).toHaveLength(1)
    expect(xml).toContain('<category term="filter"></category>')
    expect(xml).toContain(`<apps:property name="forwardTo" value="${ADDRESS}">`)
    expect(xml).toContain('<apps:property name="shouldNeverSpam" value="true">')
  })

  it('names every allow-listed sender, and only them, in one from clause', () => {
    const from = /name="from" value="([^"]*)"/.exec(xml)?.[1]
    expect(from).toBe(gmailFromQuery())
    const expected = SENDERS.flatMap((s) => s.fromAddresses)
    expect(expected.length).toBeGreaterThan(1)
    for (const address of expected) expect(from).toContain(address)
    expect(from).toBe(`(${expected.join(' OR ')})`)
  })

  it('is well formed: balanced elements, escaped attributes', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    for (const tag of ['feed', 'entry', 'author'])
      expect(xml.match(new RegExp(`<${tag}[ >]`, 'g'))?.length).toBe(
        xml.match(new RegExp(`</${tag}>`, 'g'))?.length,
      )
    const odd = gmailFilterXml('a"b<c>&@x', new Date(0))
    expect(odd).toContain('value="a&quot;b&lt;c&gt;&amp;@x"')
  })
})
