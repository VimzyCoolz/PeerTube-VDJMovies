// Telegram (MTProto) backend built on GramJS.
//
// Every object is stored as a *document* message in a private channel. Telegram
// cannot list objects, so the gateway keeps a local index (see store.js) that
// maps the S3 key to the message id. Reads go through `upload.getFile` using
// aligned windows, which lets us serve HTTP Range requests cheaply and keeps
// memory bounded for large files.
import { createWriteStream, mkdirSync, promises as fs, statSync } from 'node:fs'
import { dirname, extname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

import { config } from '../config.js'
import { alignDown } from '../s3/range.js'

const MIME_BY_EXT = {
  '.m3u8': 'application/x-mpegURL; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

export class TelegramBackend {
  constructor ({ client, Api, entity, store, partSize, cacheBytes }) {
    this.client = client
    this.Api = Api
    this.entity = entity
    this.store = store
    this.partSize = partSize
    this.cacheBytes = cacheBytes

    // LRU cache of Telegram windows. Map preserves insertion order, so we refresh
    // a key by deleting and re-inserting it.
    this._cache = new Map()
    this._inflight = new Map()
    this._cachedBytes = 0
  }

  static async create ({ store }) {
    const { TelegramClient, Api, sessions } = await import('telegram')

    const session = new sessions.StringSession('')
    const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, { connectionRetries: 5 })

    await client.start({ botAuthToken: config.telegram.botToken })

    const entity = await client.getEntity(config.telegram.channelId)

    return new TelegramBackend({
      client,
      Api,
      entity,
      store,
      partSize: config.telegram.partSize,
      cacheBytes: config.telegram.cacheBytes
    })
  }

  async put (bucket, key, source) {
    let filePath = source.path
    let cleanup = false

    if (!filePath) {
      mkdirSync(config.tmpDir, { recursive: true })
      filePath = join(config.tmpDir, 'tg-' + randomUUID())
      await pipeline(source.stream ?? source.buffer, createWriteStream(filePath))
      cleanup = true
    }

    const size = statSync(filePath).size

    let message
    try {
      message = await this.client.sendFile(this.entity, {
        file: filePath,
        caption: key,
        forceDocument: true,
        attributes: [ new this.Api.DocumentAttributeFilename({ fileName: basename(key) }) ]
      })
    } finally {
      if (cleanup) await fs.rm(filePath, { force: true }).catch(() => {})
    }

    const entry = {
      messageId: message.id,
      size,
      contentType: source.contentType || guessContentType(key),
      lastModified: Date.now()
    }
    this.store.put(key, entry)

    return { size, contentType: entry.contentType }
  }

  async head (bucket, key) {
    const entry = this.store.get(key)
    if (!entry) return null

    return { size: entry.size, contentType: entry.contentType, lastModified: entry.lastModified }
  }

  async *read (bucket, key, range) {
    const entry = this.store.get(key)
    if (!entry) throw notFound(key)

    const size = entry.size
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    if (size === 0 || end < start) return

    const location = await this._fileLocation(entry)
    const firstWindow = alignDown(start, this.partSize)

    for (let offset = firstWindow; offset <= end; offset += this.partSize) {
      const window = await this._getWindow(entry, location, offset)
      if (window.length === 0) break

      const sliceStart = Math.max(0, start - offset)
      const sliceEnd = Math.min(window.length, end - offset + 1)
      if (sliceEnd > sliceStart) yield window.subarray(sliceStart, sliceEnd)
    }
  }

  async delete (bucket, key) {
    const entry = this.store.get(key)
    if (!entry) return

    await this.client.deleteMessages(this.entity, [ entry.messageId ], { revoke: true })
    this.store.delete(key)
  }

  async list (bucket, prefix) {
    return this.store.list(prefix).map(entry => ({ key: entry.key, size: entry.size, lastModified: entry.lastModified }))
  }

  async close () {
    await this.client.disconnect().catch(() => {})
  }

  // --- internals ---

  // Message file references expire: always resolve a fresh document location before reading
  async _fileLocation (entry) {
    const messages = await this.client.getMessages(this.entity, { ids: entry.messageId })
    const doc = messages?.[0]?.media?.document
    if (!doc) throw notFound('Telegram message ' + entry.messageId + ' has no document')

    return new this.Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: ''
    })
  }

  _getWindow (entry, location, offset) {
    const cacheKey = entry.messageId + ':' + offset

    const cached = this._cache.get(cacheKey)
    if (cached) {
      this._cache.delete(cacheKey)
      this._cache.set(cacheKey, cached)
      return Promise.resolve(cached)
    }

    const inflight = this._inflight.get(cacheKey)
    if (inflight) return inflight

    const promise = (async () => {
      const result = await this.client.invoke(new this.Api.upload.GetFile({
        file: location,
        offset: BigInt(offset),
        limit: this.partSize
      }))

      const buffer = Buffer.from(result.bytes)
      this._remember(cacheKey, buffer)
      return buffer
    })().finally(() => this._inflight.delete(cacheKey))

    this._inflight.set(cacheKey, promise)
    return promise
  }

  _remember (key, buffer) {
    this._cache.set(key, buffer)
    this._cachedBytes += buffer.length

    while (this._cachedBytes > this.cacheBytes && this._cache.size > 0) {
      const [ oldestKey, oldest ] = this._cache.entries().next().value
      this._cache.delete(oldestKey)
      this._cachedBytes -= oldest.length
    }
  }
}

// ---------------------------------------------------------------------------

function guessContentType (key) {
  return MIME_BY_EXT[extname(key).toLowerCase()] || 'application/octet-stream'
}

function notFound (message) {
  const err = new Error(message)
  err.code = 'NoSuchKey'
  return err
}
