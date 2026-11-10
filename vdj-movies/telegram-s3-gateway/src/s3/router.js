// Minimal S3-compatible HTTP router.
//
// Only the operations Peertube performs are implemented, using path-style
// addressing (`/<bucket>/<key>`) because the gateway is configured with
// `object_storage.force_path_style: true`.
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, mkdirSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { parseRange } from './range.js'
import * as xml from './xml.js'

export function createRouter ({ backends, store }) {
  const backendFor = bucket => backends.get(bucket) || backends.get('*')

  return async function handleRequest (req, res) {
    try {
      await route({ req, res, backendFor, store })
    } catch (err) {
      if (res.headersSent) {
        res.destroy()
        return
      }

      sendError(res, 500, 'InternalError', err.message)
    }
  }
}

async function route ({ req, res, backendFor, store }) {
  const url = new URL(req.url, 'http://placeholder')
  const { bucket, key } = parsePath(url.pathname)
  const query = url.searchParams
  const method = req.method

  if (!bucket) return sendError(res, 400, 'InvalidRequest', 'Missing bucket')

  const backend = backendFor(bucket)
  if (!backend) return sendError(res, 404, 'NoSuchBucket', 'Bucket not configured: ' + bucket)

  // Bucket level operations
  if (key === '') {
    if (method === 'HEAD') return sendStatus(res, 200)
    if (method === 'GET') {
      if (query.has('uploads')) return sendXml(res, 200, xml.listMultipartUploads(bucket))
      return listObjects({ res, bucket, query, backend })
    }

    return sendError(res, 405, 'MethodNotAllowed', method)
  }

  // Object level operations
  if (method === 'PUT') {
    // PutObjectAcl: ACLs are not modelled, Peertube's private proxying does the access control
    if (query.has('acl')) return sendStatus(res, 200)

    // Server-side copy: answering NotImplemented makes Peertube fall back to download + upload
    if (req.headers['x-amz-copy-source']) {
      return sendError(res, 501, 'NotImplemented', 'Server side copy is not supported')
    }

    if (query.has('partNumber') && query.has('uploadId')) {
      return uploadPart({ req, res, query, store })
    }

    return putObject({ req, res, bucket, key, backend })
  }

  if (method === 'POST') {
    if (query.has('uploads')) return initiateMultipart({ req, res, bucket, key, store })
    if (query.has('uploadId')) return completeMultipart({ req, res, bucket, key, query, backend, store })

    return sendError(res, 400, 'InvalidRequest', 'Unsupported POST')
  }

  if (method === 'DELETE') {
    if (query.has('uploadId')) return abortMultipart({ res, query, store })

    await backend.delete(bucket, key)
    return sendStatus(res, 204)
  }

  if (method === 'GET' || method === 'HEAD') return getObject({ req, res, bucket, key, backend })

  return sendError(res, 405, 'MethodNotAllowed', method)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function listObjects ({ res, bucket, query, backend }) {
  const prefix = query.get('prefix') || ''
  const maxKeys = Math.min(Number.parseInt(query.get('max-keys') || '1000', 10) || 1000, 1000)
  const token = query.get('continuation-token')

  const all = await backend.list(bucket, prefix)

  let offset = 0
  if (token) {
    try {
      offset = Number.parseInt(Buffer.from(token, 'base64').toString('utf8'), 10) || 0
    } catch {
      offset = 0
    }
  }

  const page = all.slice(offset, offset + maxKeys)
  const isTruncated = offset + maxKeys < all.length
  const nextToken = isTruncated ? Buffer.from(String(offset + maxKeys)).toString('base64') : undefined

  return sendXml(res, 200, xml.listObjectsV2({
    bucket,
    prefix,
    contents: page,
    isTruncated,
    nextToken,
    maxKeys,
    keyCount: page.length
  }))
}

async function putObject ({ req, res, bucket, key, backend }) {
  const tmpPath = await stageBodyToFile(req)

  let result
  try {
    result = await backend.put(bucket, key, { path: tmpPath, contentType: req.headers['content-type'] })
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
  }

  res.setHeader('ETag', quote(buildEtag(result.size)))
  return sendStatus(res, 200)
}

function initiateMultipart ({ req, res, bucket, key, store }) {
  const uploadId = randomUUID()
  store.saveMultipart(uploadId, {
    bucket,
    key,
    contentType: req.headers['content-type'],
    parts: [],
    createdAt: Date.now()
  })

  return sendXml(res, 200, xml.initiateMultipartUpload({ bucket, key, uploadId }))
}

async function uploadPart ({ req, res, query, store }) {
  const uploadId = query.get('uploadId')
  const partNumber = Number.parseInt(query.get('partNumber'), 10)

  const session = store.getMultipart(uploadId)
  if (!session) return sendError(res, 404, 'NoSuchUpload', String(uploadId))

  const tmpPath = await stageBodyToFile(req)
  const size = (await fs.stat(tmpPath)).size

  session.parts = session.parts.filter(p => p.partNumber !== partNumber)
  session.parts.push({ partNumber, path: tmpPath, size })
  store.saveMultipart(uploadId, session)

  res.setHeader('ETag', quote(buildEtag(size)))
  return sendStatus(res, 200)
}

async function completeMultipart ({ req, res, bucket, key, query, backend, store }) {
  const uploadId = query.get('uploadId')
  const session = store.getMultipart(uploadId)
  if (!session) return sendError(res, 404, 'NoSuchUpload', String(uploadId))

  // The parts list body is unused: we concatenate the stored parts in number order
  req.resume()

  const parts = [ ...session.parts ].sort((a, b) => a.partNumber - b.partNumber)

  const assembled = join(config.tmpDir, 'assembled-' + uploadId)
  await fs.rm(assembled, { force: true })
  const output = createWriteStream(assembled)

  try {
    for (const part of parts) {
      await pipeline(createReadStream(part.path), output, { end: false })
    }
    await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()))

    const result = await backend.put(bucket, key, { path: assembled, contentType: session.contentType })

    return sendXml(res, 200, xml.completeMultipartUpload({
      location: `/${bucket}/${key}`,
      bucket,
      key,
      etag: quote(buildEtag(result.size))
    }))
  } finally {
    for (const part of parts) await fs.rm(part.path, { force: true }).catch(() => {})
    await fs.rm(assembled, { force: true }).catch(() => {})
    store.deleteMultipart(uploadId)
  }
}

async function abortMultipart ({ res, query, store }) {
  const uploadId = query.get('uploadId')
  const session = store.getMultipart(uploadId)

  if (session) {
    for (const part of session.parts) await fs.rm(part.path, { force: true }).catch(() => {})
    store.deleteMultipart(uploadId)
  }

  return sendStatus(res, 204)
}

async function getObject ({ req, res, bucket, key, backend }) {
  const info = await backend.head(bucket, key)
  if (!info) return sendError(res, 404, 'NoSuchKey', 'Object not found: ' + key)

  const rangeHeader = req.headers.range
  const range = parseRange(rangeHeader, info.size)

  if (rangeHeader && !range && info.size > 0) {
    res.setHeader('Content-Range', `bytes */${info.size}`)
    return sendError(res, 416, 'InvalidRange', rangeHeader)
  }

  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, info.size - 1)
  const length = info.size === 0 ? 0 : end - start + 1

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', quote(buildEtag(info.size)))
  if (info.contentType) res.setHeader('Content-Type', info.contentType)
  if (info.lastModified) res.setHeader('Last-Modified', new Date(info.lastModified).toUTCString())

  if (range) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
    res.statusCode = 206
  } else {
    res.statusCode = 200
  }
  res.setHeader('Content-Length', String(length))

  if (req.method === 'HEAD') return res.end()

  for await (const chunk of backend.read(bucket, key, range ? { start, end } : null)) {
    if (!res.write(chunk)) await once(res, 'drain')
  }

  return res.end()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stageBodyToFile (req) {
  mkdirSync(config.tmpDir, { recursive: true })

  const tmpPath = join(config.tmpDir, 'upload-' + randomUUID())
  await pipeline(req, createWriteStream(tmpPath))

  return tmpPath
}

function parsePath (pathname) {
  const trimmed = pathname.startsWith('/') ? pathname.slice(1) : pathname
  const slash = trimmed.indexOf('/')

  if (slash === -1) return { bucket: decode(trimmed), key: '' }

  return { bucket: decode(trimmed.slice(0, slash)), key: decode(trimmed.slice(slash + 1)) }
}

function decode (value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sendStatus (res, code) {
  res.statusCode = code
  res.end()
}

function sendXml (res, code, body) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/xml')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function sendError (res, code, errorCode, message) {
  const body = xml.error({ code: errorCode, message })

  res.statusCode = code
  res.setHeader('Content-Type', 'application/xml')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function buildEtag (size) {
  return String(size).padStart(16, '0')
}

function quote (value) {
  return '"' + value + '"'
}
