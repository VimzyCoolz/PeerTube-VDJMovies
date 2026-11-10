// Parse an HTTP `Range` header (only a single byte range is supported, which is
// all Peertube and HLS players ever send).
export function parseRange (header, size) {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [ , startRaw, endRaw ] = match
  if (startRaw === '' && endRaw === '') return null

  let start
  let end

  if (startRaw === '') {
    // Suffix range: last N bytes
    const suffix = Number.parseInt(endRaw, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(startRaw, 10)
    end = endRaw === '' ? size - 1 : Math.min(Number.parseInt(endRaw, 10), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null

  return { start, end, length: end - start + 1 }
}

// Align a byte offset down to a boundary (Telegram requires 4096-byte alignment).
export function alignDown (offset, boundary) {
  return Math.floor(offset / boundary) * boundary
}
