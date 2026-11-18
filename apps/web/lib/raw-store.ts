import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { del, get, list, put } from '@vercel/blob'
import type { RawStore } from '@warren/core'

/**
 * Private Vercel Blob store. What goes in is already sealed with the user's key (see
 * packages/db/src/context.ts), under `u/<user id>/`, so the store holds ciphertext only.
 */
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
  async deletePrefix(prefix) {
    let deleted = 0
    for (;;) {
      const page = await list({ prefix, limit: 1000 })
      if (page.blobs.length === 0) return deleted
      await del(page.blobs.map((b) => b.url))
      deleted += page.blobs.length
    }
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
    async deletePrefix(prefix) {
      const target = join(dir, prefix)
      const count = async (path: string): Promise<number> => {
        const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
        let n = 0
        for (const e of entries) n += e.isDirectory() ? await count(join(path, e.name)) : 1
        return n
      }
      const n = await count(target)
      await rm(target, { recursive: true, force: true })
      return n
    },
  }
}

export function rawStore(): RawStore {
  const dir = process.env.WARREN_RAW_STORE_DIR
  if (dir && process.env.VERCEL !== '1') return fsRawStore(dir)
  return blobRawStore
}
