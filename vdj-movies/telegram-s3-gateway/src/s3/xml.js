// Minimal S3 XML serializers for the operations Peertube performs.
// Response bodies must match what @aws-sdk/client-s3 parses.
const NS = 'http://s3.amazonaws.com/doc/2006-03-01/'

export function escapeXml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function listObjectsV2 ({ bucket, prefix, contents, isTruncated, nextToken, maxKeys, keyCount }) {
  const items = contents.map(c => (
    '<Contents>' +
      `<Key>${escapeXml(c.key)}</Key>` +
      `<LastModified>${new Date(c.lastModified ?? Date.now()).toISOString()}</LastModified>` +
      `<ETag>${escapeXml(c.etag ?? '"0"')}</ETag>` +
      `<Size>${c.size ?? 0}</Size>` +
      '<StorageClass>STANDARD</StorageClass>' +
    '</Contents>'
  )).join('')

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<ListBucketResult xmlns="${NS}">` +
      `<Name>${escapeXml(bucket)}</Name>` +
      `<Prefix>${escapeXml(prefix || '')}</Prefix>` +
      `<KeyCount>${keyCount ?? contents.length}</KeyCount>` +
      `<MaxKeys>${maxKeys ?? 1000}</MaxKeys>` +
      `<IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>` +
      (nextToken ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>` : '') +
      items +
    '</ListBucketResult>'
}

export function listMultipartUploads (bucket) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<ListMultipartUploadsResult xmlns="${NS}">` +
      `<Bucket>${escapeXml(bucket)}</Bucket>` +
      '<IsTruncated>false</IsTruncated>' +
    '</ListMultipartUploadsResult>'
}

export function initiateMultipartUpload ({ bucket, key, uploadId }) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<InitiateMultipartUploadResult xmlns="${NS}">` +
      `<Bucket>${escapeXml(bucket)}</Bucket>` +
      `<Key>${escapeXml(key)}</Key>` +
      `<UploadId>${escapeXml(uploadId)}</UploadId>` +
    '</InitiateMultipartUploadResult>'
}

export function completeMultipartUpload ({ location, bucket, key, etag }) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<CompleteMultipartUploadResult xmlns="${NS}">` +
      `<Location>${escapeXml(location)}</Location>` +
      `<Bucket>${escapeXml(bucket)}</Bucket>` +
      `<Key>${escapeXml(key)}</Key>` +
      `<ETag>${escapeXml(etag)}</ETag>` +
    '</CompleteMultipartUploadResult>'
}

export function error ({ code, message }) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error>`
}
