// Local disk backend: stores objects as regular files under <baseDir>/<bucket>/<key>.
// This is the default backend for every bucket that is not routed to Telegram,
// so non-video assets (thumbnails, avatars, torrents, staging uploads...) keep
// living on the VPS.
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fs, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

export class DiskBackend {
  constructor (baseDir) {
    this.baseDir = baseDir
    mkdirSync(baseDir, { recursive: true })
  }

  pathFor (bucket, key) {
    return join(this.baseDir, sanitizeSegment(bucket), sanitizeKey(key))
  }

  // Object metadata lives in a sibling `.vdj-meta` tree so that `list()` (which
  // walks `<baseDir>/<bucket>`) never sees it.
  metaPathFor (bucket, key) {
    return join(this.baseDir, '.vdj-meta', sanitizeSegment(bucket), sanitizeKey(key) + '.json')
  }

  async put (bucket, key, source) {
    const destination = this.pathFor(bucket, key)
    mkdirSync(dirname(destination), { recursive: true })

    if (source.path) {
      // The gateway always stages uploads to a temp file first, so a move is usually possible
      try {
        await fs.rename(source.path, destination)
      } catch {
        await fs.copyFile(source.path, destination)
        await fs.rm(source.path, { force: true })
      }
    } else {
      await pipeline(source.stream ?? source.buffer, createWriteStream(destination))
    }

    this.#writeMeta(bucket, key, { contentType: source.contentType ?? null })

    const stats = statSync(destination)
    return { size: stats.size, contentType: source.contentType }
  }

  async head (bucket, key) {
    const path = this.pathFor(bucket, key)
    if (!existsSync(path)) return null

    const meta = this.#readMeta(bucket, key)
    const stats = statSync(path)
    return { size: stats.size, contentType: meta?.contentType ?? null, lastModified: stats.mtime }
  }

  async *read (bucket, key, range) {
    const path = this.pathFor(bucket, key)
    if (!existsSync(path)) throw notFound(key)

    const stream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined)
    for await (const chunk of stream) yield chunk
  }

  async delete (bucket, key) {
    await fs.rm(this.pathFor(bucket, key), { force: true })
    await fs.rm(this.metaPathFor(bucket, key), { force: true })
  }

  async list (bucket, prefix) {
    const base = join(this.baseDir, sanitizeSegment(bucket))
    const out = []
    if (!existsSync(base)) return out

    const walk = async dir => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)

        if (entry.isDirectory()) {
          await walk(full)
          continue
        }

        const key = full.slice(base.length + 1).split(sep).join('/')
        if (!prefix || key.startsWith(prefix)) {
          const stats = statSync(full)
          out.push({ key, size: stats.size, lastModified: stats.mtime })
        }
      }
    }

    await walk(base)
    return out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }

  #writeMeta (bucket, key, meta) {
    const path = this.metaPathFor(bucket, key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(meta))
  }

  #readMeta (bucket, key) {
    const path = this.metaPathFor(bucket, key)
    if (!existsSync(path)) return null

    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------

function sanitizeSegment (value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('Invalid bucket name: ' + value)
  return cleaned
}

// Collapse `..`/`.` so a crafted key can never escape <baseDir>
function sanitizeKey (key) {
  const normalized = normalize('/' + key).replace(/^\/+/, '')
  if (normalized === '' || normalized.split('/').includes('..')) throw new Error('Invalid object key: ' + key)
  return normalized
}

function notFound (key) {
  const err = new Error('Object not found: ' + key)
  err.code = 'NoSuchKey'
  return err
}
