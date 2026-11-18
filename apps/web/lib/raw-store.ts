import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { get, put } from '@vercel/blob'
import type { RawStore } from '@warren/core'

/** Private Vercel Blob store. Pathnames contain the content hash, so overwriting is harmless. */
const blobRawStore: RawStore = {
  async put(pathname, bytes, mime) {
    await put(pathname, Buffer.from(bytes), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: mime,
    })
  },
  async get(pathname) {
    const blob = await get(pathname, { access: 'private' })
    if (!blob || blob.statusCode !== 200) return null
    return new Uint8Array(await new Response(blob.stream).arrayBuffer())
  },
}

/** Local development only: files under a directory outside version control. */
function fsRawStore(dir: string): RawStore {
  return {
    async put(pathname, bytes) {
      const file = join(dir, pathname)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
    },
    async get(pathname) {
      try {
        return new Uint8Array(await readFile(join(dir, pathname)))
      } catch {
        return null
      }
    },
  }
}

export function rawStore(): RawStore {
  const dir = process.env.WARREN_RAW_STORE_DIR
  if (dir && process.env.VERCEL !== '1') return fsRawStore(dir)
  return blobRawStore
}
