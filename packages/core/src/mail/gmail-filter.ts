import { SENDERS, type SenderPolicy } from './senders'

/*
 * The Gmail filter that forwards bank mail to a person's Warren address, in Gmail's filter import
 * format (an Atom feed, namespace http://schemas.google.com/apps/2006). The property names
 * (`from`, `forwardTo`, `shouldNeverSpam`) and the feed skeleton are those of gmailctl's XML
 * export (github.com/mbrt/gmailctl, internal/engine/export/xml), which Gmail imports. It is built
 * from `SENDERS`, so the filter cannot drift from the sender policy.
 */

/** The search Gmail runs: every allow-listed bank address, `(a OR b)`. */
export function gmailFromQuery(senders: readonly SenderPolicy[] = SENDERS): string {
  const all = senders.flatMap((s) => s.fromAddresses)
  return `(${[...new Set(all)].join(' OR ')})`
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The Atom feed to import in Gmail: one filter, from the banks, forwarded to `address`, never spam. */
export function gmailFilterXml(
  address: string,
  updated: Date,
  senders: readonly SenderPolicy[] = SENDERS,
): string {
  const property = (name: string, value: string) =>
    `    <apps:property name="${name}" value="${escapeAttr(value)}"></apps:property>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">',
    '  <title>Mail Filters</title>',
    '  <id>tag:mail.google.com,2008:filters:</id>',
    `  <updated>${updated.toISOString()}</updated>`,
    '  <author>',
    '    <name>Warren</name>',
    '  </author>',
    '  <entry>',
    '    <category term="filter"></category>',
    '    <title>Mail Filter</title>',
    '    <content></content>',
    property('from', gmailFromQuery(senders)),
    property('forwardTo', address),
    property('shouldNeverSpam', 'true'),
    '  </entry>',
    '</feed>',
    '',
  ].join('\n')
}
