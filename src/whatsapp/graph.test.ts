import { describe, expect, it } from 'vitest'
import {
  checkAudio,
  checkImage,
  createGraph,
  GraphError,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MediaError,
  shortRecipient,
  sniffAudio,
  sniffImage,
} from './graph'

describe('shortRecipient', () => {
  it('drops the mobile digit from Argentine and Mexican wa_ids', () => {
    expect(shortRecipient('5493515138578')).toBe('543515138578')
    expect(shortRecipient('5491123456789')).toBe('541123456789')
    expect(shortRecipient('5215512345678')).toBe('525512345678')
  })

  it('leaves every other number alone', () => {
    expect(shortRecipient('543515138578')).toBe('543515138578')
    expect(shortRecipient('15551439243')).toBe('15551439243')
    expect(shortRecipient('34612345678')).toBe('34612345678')
    expect(shortRecipient('54935151385789')).toBe('54935151385789')
  })
})

describe('createGraph', () => {
  const fakeGraph = (allowed: (to: string) => boolean) => {
    const tos: string[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      fetch: async (_url, init) => {
        const { to } = JSON.parse(String(init?.body))
        tos.push(to)
        if (!allowed(to))
          return new Response(JSON.stringify({ error: { message: 'not in list', code: 131030 } }), {
            status: 400,
          })
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${tos.length}` }] }))
      },
    })
    return { graph, tos }
  }

  it('sends to the wa_id when Meta accepts it', async () => {
    const { graph, tos } = fakeGraph(() => true)
    await expect(graph.sendText('5493515138578', 'hola')).resolves.toBe('wamid.1')
    expect(tos).toEqual(['5493515138578'])
  })

  it('retries once with the short form after 131030, then remembers it', async () => {
    const { graph, tos } = fakeGraph((to) => to === '543515138578')
    await expect(graph.sendText('5493515138578', 'a')).resolves.toBe('wamid.2')
    await expect(graph.sendText('5493515138578', 'b')).resolves.toBe('wamid.3')
    expect(tos).toEqual(['5493515138578', '543515138578', '543515138578'])
  })

  it('does not retry a 131030 for a number with no short form', async () => {
    const { graph, tos } = fakeGraph(() => false)
    await expect(graph.sendText('34612345678', 'a')).rejects.toMatchObject({ code: 131030 })
    expect(tos).toEqual(['34612345678'])
  })

  it('treats a recipient-list rejection as permanent', () => {
    const e = new GraphError(400, 'Recipient phone number not in allowed list', 131030)
    expect(e.notSent).toBe(true)
    expect(e.retryable).toBe(false)
  })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1])
const GIF = Buffer.from('GIF89a......')

describe('sniffImage and checkImage', () => {
  it('knows a JPEG, a PNG and a WebP by their first bytes, whatever the sender says', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(GIF)).toBeNull()
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  it('returns the bytes in base64 with the type read from them', () => {
    expect(checkImage(PNG)).toEqual({ mediaType: 'image/png', data: PNG.toString('base64') })
  })

  it('refuses a type the model cannot read, and an image over 5 MB', () => {
    expect(() => checkImage(GIF)).toThrow(expect.objectContaining({ problem: 'unsupported' }))
    expect(() => checkImage(Buffer.alloc(0))).toThrow(
      expect.objectContaining({ problem: 'unsupported' }),
    )
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)])
    expect(() => checkImage(big)).toThrow(expect.objectContaining({ problem: 'too_large' }))
    // exactly the limit is fine
    expect(
      checkImage(Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES - JPEG.length)])).mediaType,
    ).toBe('image/jpeg')
  })
})

describe('createGraph.fetchImage', () => {
  type Reply = Response | (() => Response)
  /** A Graph whose fetch answers by URL; `seen` keeps what each call carried. */
  function graphWith(routes: Record<string, Reply>) {
    const seen: { url: string; authorization: string | null }[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 'secret-token',
      fetch: async (url, init) => {
        const u = String(url)
        seen.push({ url: u, authorization: new Headers(init?.headers).get('authorization') })
        const route = routes[u]
        if (!route) return new Response('nope', { status: 404 })
        return typeof route === 'function' ? route() : route
      },
    })
    return { graph, seen }
  }
  const lookup = (o: object = {}) =>
    new Response(
      JSON.stringify({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        mime_type: 'image/jpeg',
        file_size: 7,
        ...o,
      }),
    )
  const MEDIA = 'https://graph.facebook.com/v27.0/12345'
  const FILE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'

  it('never follows a redirect on either call', async () => {
    const redirects: (string | undefined)[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      fetch: async (url, init) => {
        redirects.push(init?.redirect)
        return String(url) === MEDIA ? lookup() : new Response(JPEG)
      },
    })
    await graph.fetchImage('12345')
    expect(redirects).toEqual(['error', 'error'])
  })

  it('looks the id up, then downloads the URL, with the token on both calls', async () => {
    const { graph, seen } = graphWith({ [MEDIA]: lookup(), [FILE]: new Response(JPEG) })
    await expect(graph.fetchImage('12345')).resolves.toEqual({
      mediaType: 'image/jpeg',
      data: JPEG.toString('base64'),
    })
    expect(seen).toEqual([
      { url: MEDIA, authorization: 'Bearer secret-token' },
      { url: FILE, authorization: 'Bearer secret-token' },
    ])
  })

  it('refuses before downloading when the lookup says the file is over 5 MB', async () => {
    const { graph, seen } = graphWith({ [MEDIA]: lookup({ file_size: MAX_IMAGE_BYTES + 1 }) })
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'too_large' })
    expect(seen).toHaveLength(1)
  })

  it('refuses before downloading when the lookup says it is not an image', async () => {
    const { graph, seen } = graphWith({ [MEDIA]: lookup({ mime_type: 'application/pdf' }) })
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'unsupported' })
    expect(seen).toHaveLength(1)
  })

  it('refuses a download whose bytes are not a JPEG, PNG or WebP, whatever the lookup said', async () => {
    const { graph } = graphWith({ [MEDIA]: lookup(), [FILE]: new Response(GIF) })
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'unsupported' })
  })

  it('stops reading a body that is over 5 MB with no content-length', async () => {
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024).fill(1)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
        if (pulled > 50) controller.close()
      },
    })
    const { graph } = graphWith({ [MEDIA]: lookup({ file_size: 1 }), [FILE]: new Response(body) })
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'too_large' })
    expect(pulled).toBeLessThan(10) // it did not read the whole stream
  })

  it('refuses a declared content-length over 5 MB without reading the body', async () => {
    const big = new Response(JPEG, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })
    const { graph } = graphWith({ [MEDIA]: lookup({ file_size: 1 }), [FILE]: big })
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'too_large' })
  })

  it('does not send the token anywhere but to Meta over https', async () => {
    for (const url of [
      'http://lookaside.fbsbx.com/x',
      'https://evil.example.com/x',
      'https://fbsbx.com.evil.example/x',
      'https://127.0.0.1/x',
      'not a url',
    ]) {
      const { graph, seen } = graphWith({ [MEDIA]: lookup({ url }) })
      await expect(graph.fetchImage('12345'), url).rejects.toMatchObject({ problem: 'unavailable' })
      expect(seen, url).toHaveLength(1) // only the lookup, on graph.facebook.com
    }
  })

  it('accepts the hosts Meta serves media from', async () => {
    for (const host of ['lookaside.fbsbx.com', 'mmg.whatsapp.net', 'scontent.xx.fbcdn.net']) {
      const url = `https://${host}/f?mid=1`
      const { graph } = graphWith({ [MEDIA]: lookup({ url }), [url]: new Response(PNG) })
      await expect(graph.fetchImage('12345'), host).resolves.toMatchObject({
        mediaType: 'image/png',
      })
    }
  })

  it('is unavailable when Meta says no or the network fails, and for a bad media id', async () => {
    const down = graphWith({ [MEDIA]: new Response('x', { status: 500 }) })
    await expect(down.graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'unavailable' })
    const gone = graphWith({ [MEDIA]: lookup(), [FILE]: new Response('x', { status: 410 }) })
    await expect(gone.graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'unavailable' })
    const broken = graphWith({
      [MEDIA]: () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(broken.graph.fetchImage('12345')).rejects.toBeInstanceOf(MediaError)
    const bad = graphWith({})
    for (const id of ['', '../x', '1/2', 'a b', 'x'.repeat(101)]) {
      await expect(bad.graph.fetchImage(id), id).rejects.toMatchObject({ problem: 'unavailable' })
    }
    expect(bad.seen).toHaveLength(0)
  })

  it('gives up on a download that hangs, inside one budget for the lookup and the download', async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      mediaBudgetMs: 30,
      fetch: hang as unknown as typeof fetch,
    })
    const started = Date.now()
    await expect(graph.fetchImage('12345')).rejects.toMatchObject({ problem: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('passes an abort through instead of calling it a photo problem', async () => {
    const abort = new AbortController()
    abort.abort(new Error('deadline'))
    const { graph } = graphWith({
      [MEDIA]: () => {
        throw abort.signal.reason
      },
    })
    await expect(graph.fetchImage('12345', abort.signal)).rejects.toThrow('deadline')
  })
})

describe('voice notes', () => {
  const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0])
  const M4A = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])
  const MP3_ID3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0])
  const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  const AAC = Buffer.from([0xff, 0xf1, 0x50, 0x80])
  const AMR = Buffer.from('#!AMR\n')
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('sniffs Ogg, MP4/M4A and MP3 from the bytes, and nothing else the service would refuse', () => {
    expect(sniffAudio(OGG)).toEqual({ mediaType: 'audio/ogg', extension: 'ogg' })
    expect(sniffAudio(M4A)).toEqual({ mediaType: 'audio/mp4', extension: 'm4a' })
    expect(sniffAudio(MP3_ID3)).toEqual({ mediaType: 'audio/mpeg', extension: 'mp3' })
    expect(sniffAudio(MP3_FRAME)).toEqual({ mediaType: 'audio/mpeg', extension: 'mp3' })
    expect(sniffAudio(AAC)).toBeNull() // raw ADTS AAC: the service answers 400
    expect(sniffAudio(AMR)).toBeNull()
    expect(sniffAudio(PNG)).toBeNull()
    expect(sniffAudio(new Uint8Array())).toBeNull()
  })

  it('caps a note at 3 MB, whatever it claims to be', () => {
    expect(() => checkAudio(Buffer.concat([OGG, Buffer.alloc(MAX_AUDIO_BYTES)]))).toThrow(
      expect.objectContaining({ problem: 'too_large' }),
    )
    expect(
      checkAudio(Buffer.concat([OGG, Buffer.alloc(MAX_AUDIO_BYTES - OGG.length)])).mediaType,
    ).toBe('audio/ogg')
    expect(() => checkAudio(AMR)).toThrow(expect.objectContaining({ problem: 'unsupported' }))
  })

  const MEDIA = 'https://graph.facebook.com/v27.0/777'
  const FILE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=7'
  const lookup = (o: object = {}) =>
    new Response(JSON.stringify({ url: FILE, mime_type: 'audio/ogg', file_size: 7, ...o }))
  function graphWith(routes: Record<string, Response | (() => Response)>, extra: object = {}) {
    const seen: { url: string; authorization: string | null; redirect?: string }[] = []
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 'secret-token',
      ...extra,
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
          redirect: init?.redirect,
        })
        const route = routes[String(url)]
        if (!route) return new Response('nope', { status: 404 })
        return typeof route === 'function' ? route() : route
      },
    })
    return { graph, seen }
  }

  it('is downloaded with the same host check, token and no redirects as a photo', async () => {
    const { graph, seen } = graphWith({ [MEDIA]: lookup(), [FILE]: new Response(OGG) })
    await expect(graph.fetchAudio('777')).resolves.toMatchObject({ mediaType: 'audio/ogg' })
    expect(seen).toEqual([
      { url: MEDIA, authorization: 'Bearer secret-token', redirect: 'error' },
      { url: FILE, authorization: 'Bearer secret-token', redirect: 'error' },
    ])
    for (const url of ['http://lookaside.fbsbx.com/x', 'https://evil.example.com/x']) {
      const bad = graphWith({ [MEDIA]: lookup({ url }) })
      await expect(bad.graph.fetchAudio('777'), url).rejects.toMatchObject({
        problem: 'unavailable',
      })
      expect(bad.seen).toHaveLength(1)
    }
  })

  it('refuses before downloading when the lookup says it is over 3 MB or not audio', async () => {
    const big = graphWith({ [MEDIA]: lookup({ file_size: MAX_AUDIO_BYTES + 1 }) })
    await expect(big.graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'too_large' })
    expect(big.seen).toHaveLength(1)
    const photo = graphWith({ [MEDIA]: lookup({ mime_type: 'image/jpeg' }) })
    await expect(photo.graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'unsupported' })
    expect(photo.seen).toHaveLength(1)
  })

  it('refuses a body whose bytes are not a supported audio format, or over 3 MB with no content-length', async () => {
    const png = graphWith({ [MEDIA]: lookup(), [FILE]: new Response(PNG) })
    await expect(png.graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'unsupported' })
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024).fill(1)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
        if (pulled > 50) controller.close()
      },
    })
    const stream = graphWith({ [MEDIA]: lookup({ file_size: 1 }), [FILE]: new Response(body) })
    await expect(stream.graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'too_large' })
    expect(pulled).toBeLessThan(6) // stopped at 3 MB, did not read the stream
    const declared = graphWith({
      [MEDIA]: lookup({ file_size: 1 }),
      [FILE]: new Response(OGG, { headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) } }),
    })
    await expect(declared.graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'too_large' })
  })

  it('gives up on a download that hangs, inside one budget', async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const graph = createGraph({
      version: 'v27.0',
      phoneNumberId: '1',
      token: 't',
      mediaBudgetMs: 30,
      fetch: hang as unknown as typeof fetch,
    })
    const started = Date.now()
    await expect(graph.fetchAudio('777')).rejects.toMatchObject({ problem: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
