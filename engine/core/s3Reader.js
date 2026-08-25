// ═══════════════════════════════════════════════════════════════════════════
// S3 image reader.
//
// SKU images are stored as PRIVATE objects under sku-images/{userId}/{skuId}/,
// and the row only ever holds the s3Key — never a presigned URL (they die in
// ~1h and permanently break the saved row).
//
// So the engine reads bytes DIRECTLY with the EC2 instance role and inlines
// them as base64. No presigning anywhere in this path: nothing to expire, and
// vision models cannot fetch URLs anyway (Phase 2 session-16 lesson — a URL in
// prompt text is inert noise; the image must be ATTACHED).
//
// PREREQUISITE: the EC2 instance role needs s3:GetObject on the bucket.
// PutObject alone is not enough — verify before the first run:
//     aws s3api head-object --bucket <bucket> --key sku-images/<user>/<sku>/<file>.jpg
// ═══════════════════════════════════════════════════════════════════════════

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const BUCKET = process.env.SKU_BUCKET || 'video-template-bucket-20241209-cloudshell-user';
const MAX_EDGE = parseInt(process.env.SKU_IMAGE_MAX_EDGE, 10) || 1568;

const s3 = new S3Client({ region: REGION });

// sharp is an optionalDependency — if the native build failed on this box we
// still work, just with bigger payloads. Never let its absence kill a job.
let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {
  console.warn('[s3Reader] sharp unavailable — images will be sent at original size');
}

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function normaliseMediaType(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  return ALLOWED_MEDIA.includes(m) ? m : 'image/jpeg';
}

// The stored mimeType comes from the browser's file.type, which is derived from
// the FILE EXTENSION and routinely lies — a JPEG saved as .png arrives declared
// image/png. Anthropic reads the actual bytes and rejects the mismatch:
//   "specified using the image/png media type, but the image appears to be
//    a image/jpeg image"
// So the header wins. Never send a declared type we haven't verified.
function sniffMediaType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Read one SKU image and return it ready to attach.
 * @returns {{ base64: string, mediaType: string, bytes: number, s3Key: string }}
 */
async function readImageForVision(s3Key, mimeType) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  let buf = await streamToBuffer(out.Body);

  // Bytes beat the declared type, every time.
  const sniffed = sniffMediaType(buf);
  let mediaType = sniffed || normaliseMediaType(mimeType || out.ContentType);
  if (sniffed && mimeType && normaliseMediaType(mimeType) !== sniffed) {
    console.warn(`[s3Reader] ${s3Key} declared ${mimeType} but is ${sniffed} — using ${sniffed}`);
  }

  if (sharp) {
    try {
      const img = sharp(buf, { failOn: 'none' });
      const meta = await img.metadata();
      const longEdge = Math.max(meta.width || 0, meta.height || 0);

      // Re-encode when it's oversized OR when we couldn't identify the header.
      // An unrecognised container is exactly the case that fails at the provider.
      if (longEdge > MAX_EDGE || !sniffed) {
        // Re-encode as JPEG on white: alpha matters for the SKU library, but
        // not for a model that is only reading the pack.
        buf = await img
          .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 88 })
          .toBuffer();
        mediaType = 'image/jpeg';
      }
    } catch (err) {
      console.warn(`[s3Reader] downscale failed for ${s3Key}, sending original:`, err.message);
    }
  }

  return {
    s3Key,
    mediaType,
    bytes: buf.length,
    base64: buf.toString('base64'),
  };
}

/** Offload an oversized analysis JSON. Returns the bare object URL + key. */
async function putAnalysisJson(key, json) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
  // BARE object url — never presigned. Read back through the instance role.
  return { s3Key: key, url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`, bytes: body.length };
}

async function putShotImage(key, buffer, contentType = 'image/png') {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  console.log(`[s3Reader] stored shot ${key} (${(buffer.length / 1024).toFixed(0)}KB)`);
  return { s3Key: key, bytes: buffer.length };
}

async function presignForRead(s3Key, expiresIn = 21600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }), { expiresIn });
}

module.exports = { readImageForVision, putAnalysisJson, putShotImage, presignForRead, BUCKET };