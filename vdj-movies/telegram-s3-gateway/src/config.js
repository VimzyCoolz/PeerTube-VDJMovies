// Gateway configuration. Everything is driven by environment variables so the
// service can run as a systemd unit next to Peertube without extra config files.
import { resolve } from 'node:path'

function parseList (value) {
  return (value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function parsePositiveInt (value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const config = {
  host: process.env.GATEWAY_HOST || '0.0.0.0',
  port: parsePositiveInt(process.env.GATEWAY_PORT, 9100),

  // Where the `disk` backend stores objects, and where uploads are staged.
  dataDir: resolve(process.env.GATEWAY_DATA_DIR || './data'),
  tmpDir: resolve(process.env.GATEWAY_TMP_DIR || './tmp'),

  // Buckets handled by the Telegram backend. Every other bucket is served by the disk backend.
  // Set to an empty string to run in disk-only mode (useful for local testing).
  telegramBuckets: new Set(parseList(process.env.GATEWAY_TELEGRAM_BUCKETS ?? 'telegram')),

  telegram: {
    apiId: Number.parseInt(process.env.TELEGRAM_API_ID || '0', 10),
    apiHash: process.env.TELEGRAM_API_HASH || '',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',

    // Telegrams upload.getFile requires the offset to be a multiple of 4096 bytes
    // and limits each request to 1 MiB. We fetch windows of this size and cache them.
    partSize: Math.min(parsePositiveInt(process.env.TELEGRAM_PART_SIZE, 512 * 1024), 1024 * 1024),

    // In-memory LRU cache for Telegram windows (bytes).
    cacheBytes: parsePositiveInt(process.env.TELEGRAM_CACHE_BYTES, 64 * 1024 * 1024)
  }
}

export function validateConfig () {
  if (config.telegramBuckets.size === 0) return

  const { apiId, apiHash, botToken, channelId } = config.telegram
  const missing = []
  if (!apiId) missing.push('TELEGRAM_API_ID')
  if (!apiHash) missing.push('TELEGRAM_API_HASH')
  if (!botToken) missing.push('TELEGRAM_BOT_TOKEN')
  if (!channelId) missing.push('TELEGRAM_CHANNEL_ID')

  if (missing.length !== 0) {
    throw new Error(
      `Buckets [${[ ...config.telegramBuckets ].join(', ')}] are routed to the Telegram backend but these environment ` +
      `variables are missing: ${missing.join(', ')}`
    )
  }
}
