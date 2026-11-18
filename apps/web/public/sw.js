/*
 * Warren's service worker. It handles push and notification clicks, and nothing else: no
 * caching, no offline. The payload is {title, body, tag, url}, sent by the server (never raw
 * mail). `tag` makes a repeated notice replace the earlier one.
 */

// A new worker takes over at once, so a fixed sw.js does not wait for every tab to close.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const text = (value) => (typeof value === 'string' ? value : undefined)
  // A browser that receives a push and shows nothing may revoke the subscription, so a
  // notification is always shown, even for a payload that cannot be read.
  event.waitUntil(
    self.registration.showNotification(text(data.title) || 'Warren', {
      body: text(data.body) || '',
      tag: text(data.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: text(data.url) || '/movements' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // Only this site's own pages: a payload cannot send the person elsewhere.
  const target = new URL(event.notification.data?.url || '/movements', self.location.origin)
  if (target.origin !== self.location.origin) return
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        try {
          await open.focus()
          await open.navigate(target.href)
          return
        } catch {
          // navigate() refuses for a window the worker does not control: open a new one.
        }
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
