// VDJ Movies - Telegram S3 gateway.
//
// Presents a small S3-compatible endpoint to Peertube. Buckets listed in
// GATEWAY_TELEGRAM_BUCKETS are stored on Telegram; every other bucket is kept
// on local disk, so Peertube can run with `object_storage.enabled: true` while
// only video (HLS) objects actually leave the VPS.
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DiskBackend } from './backends/disk.js'
import { config, validateConfig } from './config.js'
import { createRouter } from './s3/router.js'
import { ObjectStore } from './store.js'

async function main () {
  validateConfig()

  const diskDir = join(config.dataDir, 'disk')
  mkdirSync(diskDir, { recursive: true })
  mkdirSync(config.tmpDir, { recursive: true })

  const store = new ObjectStore(join(config.dataDir, 'objects-index.json'))
  const backends = new Map([ [ '*', new DiskBackend(diskDir) ] ])

  let telegram
  if (config.telegramBuckets.size !== 0) {
    const { TelegramBackend } = await import('./backends/telegram.js')

    telegram = await TelegramBackend.create({ store })
    for (const bucket of config.telegramBuckets) backends.set(bucket, telegram)

    console.log(`[gateway] Telegram backend ready for buckets: ${[ ...config.telegramBuckets ].join(', ')}`)
  } else {
    console.log('[gateway] Telegram disabled (GATEWAY_TELEGRAM_BUCKETS empty), all buckets served from disk')
  }

  const server = createServer(createRouter({ backends, store }))

  // Never time out a long upload or a long media download
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0

  server.listen(config.port, config.host, () => {
    console.log(`[gateway] listening on http://${config.host}:${config.port}`)
    console.log(`[gateway] disk backend directory: ${diskDir}`)
  })

  const shutdown = async () => {
    console.log('[gateway] shutting down')
    store.flush()
    await telegram?.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('[gateway] fatal:', err)
  process.exit(1)
})
