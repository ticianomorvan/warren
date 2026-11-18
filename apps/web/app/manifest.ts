import type { MetadataRoute } from 'next'
import { t } from '../lib/strings'

/** Colors match globals.css: the page background, and the accent the icon is drawn on. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: t.appName,
    short_name: t.appName,
    description: 'Tus movimientos, con un aviso por cada uno.',
    lang: 'es-AR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f7f6f3',
    theme_color: '#1f5c4a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
