// End-to-end smoke test for the gateway's S3 protocol, using the exact client
// stack Peertube uses (@aws-sdk/client-s3 + lib-storage multipart + presigner).
//
// Runs the gateway in disk-only mode (GATEWAY_TELEGRAM_BUCKETS='') so no
// Telegram credentials are required. Validates the HTTP/XML contract that the
// Telegram backend also relies on.
//
// Usage: node test/smoke.mjs   (requires @aws-sdk/client-s3, @aws-sdk/lib-storage,
//                                @aws-sdk/s3-request-presigner to be installed)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = 9199
const workDir = mkdtempSync(join(tmpdir(), 'vdj-gw-'))

const telegramBucket = 'telegram' // routed to '*' (disk) in this run
let child

async function main () {
  child = spawn(process.execPath, [ join(here, '..', 'src', 'server.js') ], {
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      GATEWAY_DATA_DIR: join(workDir, 'data'),
      GATEWAY_TMP_DIR: join(workDir, 'tmp'),
      GATEWAY_TELEGRAM_BUCKETS: ''
    },
    stdio: [ 'ignore', 'pipe', 'pipe' ]
  })

  child.stderr.on('data', d => process.stderr.write('[gateway] ' + d))
  await waitForListening(child)

  const s3 = await import('@aws-sdk/client-s3')
  const { Upload } = await import('@aws-sdk/lib-storage')
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

  const client = new s3.S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })

  let passed = 0
  const check = (name) => { passed++; console.log(`  ok - ${name}`) }

  // 1. HeadBucket (Peertube's startup check)
  await client.send(new s3.HeadBucketCommand({ Bucket: telegramBucket }))
  check('HeadBucket')

  // 2. PutObject + GetObject (HLS playlist content, like storeHLSFileFromContent)
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\nhls/master.m3u8\n'
  await client.send(new s3.PutObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-1/master.m3u8',
    Body: playlist,
    ContentType: 'application/x-mpegURL; charset=utf-8'
  }))

  const got = await client.send(new s3.GetObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-1/master.m3u8'
  }))
  assert.equal(await got.Body.transformToString(), playlist)
  assert.equal(got.ContentType, 'application/x-mpegURL; charset=utf-8')
  check('PutObject + GetObject (playlist)', )

  // 3. HTTP Range request (HLS reads byte ranges from the fragmented mp4)
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
  await client.send(new s3.PutObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-2/240-fragmented.mp4',
    Body: bytes,
    ContentType: 'video/mp4'
  }))

  const ranged = await client.send(new s3.GetObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-2/240-fragmented.mp4',
    Range: 'bytes=10-19'
  }))
  assert.equal(ranged.$metadata.httpStatusCode, 206)
  assert.equal(ranged.ContentRange, 'bytes 10-19/100')
  assert.deepEqual(Buffer.from(await ranged.Body.transformToByteArray()), bytes.subarray(10, 20))
  check('GetObject with Range -> 206 + Content-Range')

  // 4. Multipart upload through lib-storage (how Peertube uploads files >= partSize)
  const localFile = join(workDir, 'segment.mp4')
  const big = randomBytes(12 * 1024 * 1024)
  writeFileSync(localFile, big)
  const bigHash = createHash('sha256').update(big).digest('hex')

  const { createReadStream } = await import('node:fs')
  const upload = new Upload({
    client,
    queueSize: 2,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: true,
    params: {
      Bucket: telegramBucket,
      Key: 'streaming-playlists/hls/uuid-3/480-fragmented.mp4',
      Body: createReadStream(localFile),
      ContentType: 'video/mp4'
    }
  })
  const uploadResult = await upload.done()
  assert.ok(uploadResult.Bucket, 'CompleteMultipartUpload result must contain Bucket')
  check('multipart upload (lib-storage) -> result has Bucket')

  const head = await client.send(new s3.HeadObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-3/480-fragmented.mp4'
  }))
  assert.equal(head.ContentLength, big.length)

  const downloaded = await client.send(new s3.GetObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-3/480-fragmented.mp4'
  }))
  assert.equal(createHash('sha256').update(Buffer.from(await downloaded.Body.transformToByteArray())).digest('hex'), bigHash)
  check('multipart download integrity (sha256)')

  // 5. ListObjectsV2 by prefix (used by removePrefix / listing HLS keys)
  const listed = await client.send(new s3.ListObjectsV2Command({
    Bucket: telegramBucket,
    Prefix: 'streaming-playlists/hls/uuid-3/'
  }))
  assert.equal(listed.KeyCount, 1)
  assert.equal(listed.Contents[0].Key, 'streaming-playlists/hls/uuid-3/480-fragmented.mp4')
  assert.equal(listed.Contents[0].Size, big.length)
  check('ListObjectsV2 by prefix')

  // 6. PutObjectAcl is accepted as a no-op
  await client.send(new s3.PutObjectAclCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-1/master.m3u8',
    ACL: 'private'
  }))
  check('PutObjectAcl no-op')

  // 7. Server-side copy reports NotImplemented so Peertube falls back to download+upload
  await assert.rejects(
    client.send(new s3.CopyObjectCommand({
      Bucket: telegramBucket,
      Key: 'streaming-playlists/hls/uuid-2/copy.mp4',
      CopySource: `${telegramBucket}/streaming-playlists/hls/uuid-2/240-fragmented.mp4`
    })),
    err => err.$metadata?.httpStatusCode === 501
  )
  check('CopyObject -> 501 NotImplemented')

  // 8. Presigned GET URL (Peertube uses these for downloads)
  const signedUrl = await getSignedUrl(client, new s3.GetObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-1/master.m3u8'
  }), { expiresIn: 3600 })
  const res = await fetch(signedUrl)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), playlist)
  check('presigned GET URL')

  // 9. DeleteObject then HeadObject -> 404
  await client.send(new s3.DeleteObjectCommand({
    Bucket: telegramBucket,
    Key: 'streaming-playlists/hls/uuid-2/240-fragmented.mp4'
  }))
  await assert.rejects(
    client.send(new s3.HeadObjectCommand({
      Bucket: telegramBucket,
      Key: 'streaming-playlists/hls/uuid-2/240-fragmented.mp4'
    })),
    err => err.$metadata?.httpStatusCode === 404
  )
  check('DeleteObject + HeadObject 404')

  console.log(`\nAll checks passed (${passed}).`)
}

function waitForListening (proc) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('gateway did not start in time')), 15000)

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.once('error', reject)
    proc.once('exit', code => {
      clearTimeout(timer)
      reject(new Error('gateway exited early with code ' + code))
    })
  })
}

main()
  .then(() => {
    child?.kill('SIGTERM')
    rmSync(workDir, { recursive: true, force: true })
  })
  .catch(err => {
    console.error('\nSMOKE TEST FAILED\n', err)
    child?.kill('SIGTERM')
    rmSync(workDir, { recursive: true, force: true })
    process.exit(1)
  })
