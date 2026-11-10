// Durable index of objects stored in the Telegram backend.
//
// Telegram has no way to list "keys" inside a channel, so we keep our own map:
// object key -> message metadata (message id, size, content type...). Listing,
// head and existence checks are served from this index; only the actual bytes
// live on Telegram.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class ObjectStore {
  constructor (file, { flushDelay = 200 } = {}) {
    this.file = file
    this.flushDelay = flushDelay
    this.objects = new Map()
    this.multipart = new Map()
    this._timer = null

    mkdirSync(dirname(file), { recursive: true })

    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [ key, value ] of Object.entries(raw.objects || {})) this.objects.set(key, value)
      for (const [ id, value ] of Object.entries(raw.multipart || {})) this.multipart.set(id, value)
    }
  }

  get (key) {
    return this.objects.get(key) || null
  }

  put (key, entry) {
    this.objects.set(key, entry)
    this.scheduleFlush()
  }

  delete (key) {
    const deleted = this.objects.delete(key)
    if (deleted) this.scheduleFlush()
    return deleted
  }

  // Objects whose key starts with `prefix`, sorted lexicographically like S3.
  list (prefix) {
    const result = []
    for (const [ key, value ] of this.objects) {
      if (!prefix || key.startsWith(prefix)) result.push({ key, ...value })
    }

    return result.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }

  saveMultipart (id, session) {
    this.multipart.set(id, session)
    this.scheduleFlush()
  }

  getMultipart (id) {
    return this.multipart.get(id) || null
  }

  deleteMultipart (id) {
    const deleted = this.multipart.delete(id)
    if (deleted) this.scheduleFlush()
    return deleted
  }

  scheduleFlush () {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, this.flushDelay)
    this._timer.unref?.()
  }

  // Synchronous atomic write: uploads are low-volume, and a lost index means orphaned
  // Telegram messages, so we favour durability over throughput here.
  flush () {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }

    const payload = JSON.stringify({
      objects: Object.fromEntries(this.objects),
      multipart: Object.fromEntries(this.multipart)
    })

    const tmp = this.file + '.tmp'
    writeFileSync(tmp, payload)
    renameSync(tmp, this.file)
  }
}
