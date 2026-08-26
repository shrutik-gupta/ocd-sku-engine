// ============================================================================
// gemini_omni.js — Gemini Omni Flash (Google, preview) video adapter
//
// Session 18. Same GEMINI_API_KEY (Google AI Studio) as nanabanana.js — no new
// key, no ecosystem.config.js change.
//
// DROP-IN: mirrors seedance.js's engine contract EXACTLY —
//   • module.exports = { execute }
//   • execute({ prompt, inputs, model, stepId, tileIndex })
//   • reference images collected from inputs (imageUrls / referenceImages /
//     referenceImage) — the step's default `referenceImage: {{imageUpload}}`
//     Inputs box entry works unchanged
//   • uploadBufferToS3(buffer, key, contentType) from ../core/s3Uploader
//   • returns { outputs:[{label,type:"video",url}], caption, model }
//
// API contract (ai.google.dev/gemini-api/docs/omni):
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
//   Auth: "x-goog-api-key" HEADER — never ?key= in a URL (session-14 key-leak
//     lesson: a logged URL can never leak the key).
//   UNARY: unlike ModelArk there is NO create-task→poll split — the POST itself
//     blocks until the video is fully generated (minutes). Only the file
//     download step polls. Hence the 10-minute axios timeout.
//   Images: Omni wants INLINE BASE64 parts (ModelArk takes URLs) — so each
//     reference image is downloaded and base64'd first.
//   Aspect ratio: ONLY "16:9" (default) and "9:16" exist. No 1:1 — anything
//     else from inputs.aspectRatio maps to "16:9".
//   delivery:"uri": inline base64 responses cap at ~4MB, so always request a
//     Google-hosted file URI → poll Files API until ACTIVE → download.
//   NOT supported: system instructions, temperature, duration / resolution
//     params (steer clip length in the prompt text, e.g. "5 seconds, single
//     continuous shot"), video extension.
// ============================================================================
const axios = require('axios');
const { uploadBufferToS3 } = require('../core/s3Uploader');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OMNI_MODEL_ID_DEFAULT = 'gemini-omni-flash-preview';
const CREATE_TIMEOUT_MS = 10 * 60 * 1000; // unary — generation happens inside this one request
const CREATE_MAX_ATTEMPTS = 4;                       // 1 try + up to 3 backoff retries on 429/500/503
const CREATE_BACKOFF_MS = [0, 20000, 45000, 90000];  // wait before attempts 2..4 (Retry-After header wins)
const FILE_POLL_INTERVAL_MS = 5000;
const FILE_MAX_POLLS = 60;                // 60 × 5s = 5 min max wait for file ACTIVE

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Omni Flash supports ONLY 16:9 and 9:16 — map everything else to 16:9.
function mapAspectRatio(ar) {
  return String(ar || '').trim() === '9:16' ? '9:16' : '16:9';
}

// Same shapes seedance.js accepts — collect + dedupe reference image URLs.
function collectImageUrls(inputs) {
  const set = new Set();
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach((u) => typeof u === 'string' && u.startsWith('http') && set.add(u));
    else if (typeof v === 'string' && v.startsWith('http')) set.add(v);
  };
  push(inputs.imageUrls);
  push(inputs.referenceImages);
  push(inputs.referenceImage);
  return [...set];
}

// Download a reference image and return the inline base64 part Omni expects.
// Workbook test uploads are PRESIGNED S3 URLs → plain HTTPS works. If a BARE
// private-bucket URL ever lands here it will 403 — that's the moment to copy
// the AWS-SDK GetObject fallback from openai_image.js (session-16 lesson).
async function fetchImagePart(url, tag) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const headerMime = (res.headers['content-type'] || '').split(';')[0];
  const mime = headerMime.startsWith('image/')
    ? headerMime
    : (url.split('?')[0].toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
  console.log(`${tag} reference image downloaded — ${res.data.length} bytes, ${mime}`);
  return { type: 'image', data: Buffer.from(res.data).toString('base64'), mime_type: mime };
}

// delivery:"uri" gives a Google Files URI → poll until ACTIVE → download bytes.
async function downloadVideoFromFilesApi(uri, apiKey, tag) {
  const m = String(uri).match(/files\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`gemini_omni could not parse file id from uri: ${uri}`);
  const fileId = m[1];
  const headers = { 'x-goog-api-key': apiKey };

  for (let i = 0; i < FILE_MAX_POLLS; i++) {
    let state;
    try {
      const info = await axios.get(`${GEMINI_BASE}/files/${fileId}`, { headers, timeout: 30000 });
      state = info.data && info.data.state;
    } catch (err) {
      console.error(`${tag} file poll ${i + 1} error:`, err.response?.status, JSON.stringify(err.response?.data || err.message).slice(0, 400));
      await sleep(FILE_POLL_INTERVAL_MS);
      continue; // transient — keep polling
    }
    if (state === 'ACTIVE') break;
    if (state === 'FAILED') throw new Error('gemini_omni: Google reports video file FAILED');
    if (i === FILE_MAX_POLLS - 1) throw new Error(`gemini_omni: file not ACTIVE after ${(FILE_MAX_POLLS * FILE_POLL_INTERVAL_MS) / 1000}s`);
    if (i % 4 === 0) console.log(`${tag} file poll ${i + 1}/${FILE_MAX_POLLS} — state: ${state}`);
    await sleep(FILE_POLL_INTERVAL_MS);
  }

  console.log(`${tag} downloading provider video`);
  const dl = await axios.get(`${GEMINI_BASE}/files/${fileId}:download?alt=media`, {
    headers,
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: Infinity,
  });
  return Buffer.from(dl.data);
}

async function execute({ prompt, inputs = {}, model, stepId, tileIndex }) {
  const tag = `[gemini_omni]${tileIndex != null ? ` tile ${tileIndex}` : ''}`;
  const modelId = model || OMNI_MODEL_ID_DEFAULT;
  if (!process.env.GEMINI_API_KEY) throw new Error(`${tag} GEMINI_API_KEY not set`);
  const apiKey = process.env.GEMINI_API_KEY;

  const imageUrls = collectImageUrls(inputs);
  const aspect = mapAspectRatio(inputs.aspectRatio);

  // Build input parts: images first (inline base64), then the text prompt.
  const input = [];
  for (const url of imageUrls) input.push(await fetchImagePart(url, tag));
  input.push({ type: 'text', text: String(prompt || '') });

  const requestBody = {
    model: modelId,
    input,
    response_format: { type: 'video', aspect_ratio: aspect, delivery: 'uri' },
    // task: text_to_video | image_to_video | reference_to_video | edit.
    // Only sent when the step's Inputs box sets `task`; otherwise the model
    // infers from the prompt (Google's own product-shot example does this).
    // For product shots: `task: reference_to_video` = product as subject
    // reference; `task: image_to_video` = product image as literal first frame.
    ...(inputs.task ? { generation_config: { video_config: { task: String(inputs.task) } } } : {}),
  };

  console.log(`${tag} create interaction — model: ${modelId}, images: ${imageUrls.length}, aspect: ${aspect}, prompt: ${(prompt || '').slice(0, 100)}`);
  // Log the body WITHOUT base64 payloads (they'd flood pm2 logs)
  const bodyForLog = {
    ...requestBody,
    input: requestBody.input.map((p) =>
      p.type === 'image' ? { type: 'image', mime_type: p.mime_type, data: `<base64 ${p.data.length} chars>` } : p
    ),
  };
  console.log(`${tag} request body:`, JSON.stringify(bodyForLog).slice(0, 600));

  // 1) UNARY create — blocks until the video is generated.
  // Preview models run on a DYNAMIC SHARED QUOTA (a global capacity pool
  // across all users), so paid Tier-1 projects still get 429'd under load —
  // session-18 lesson: the first live call 429'd on a paid project. Retry
  // transient failures (429 quota/capacity, 500, 503) with backoff before
  // failing the job.
  let interaction;
  for (let attempt = 1; attempt <= CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(`${GEMINI_BASE}/interactions`, requestBody, {
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: CREATE_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      interaction = res.data;
      break;
    } catch (err) {
      const status = err.response?.status;
      // Log the REAL error body, throw a CLEAN message — never rethrow the raw
      // AxiosError (it dumps the request incl. auth headers into pm2 logs).
      console.error(`${tag} CREATE attempt ${attempt}/${CREATE_MAX_ATTEMPTS} failed:`, status, JSON.stringify(err.response?.data || err.message).slice(0, 800));
      const retriable = [429, 500, 503].includes(status);
      if (!retriable || attempt === CREATE_MAX_ATTEMPTS) {
        throw new Error(`gemini_omni interaction failed after ${attempt} attempt(s): ${err.response?.data?.error?.message || err.message}`);
      }
      const retryAfterSec = Number(err.response?.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 120000)
        : CREATE_BACKOFF_MS[attempt];
      console.log(`${tag} ${status} is transient (preview capacity / shared quota) — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${CREATE_MAX_ATTEMPTS})`);
      await sleep(waitMs);
    }
  }

  // 2) Extract the video part. Raw REST puts it in steps[] → the
  // type:"model_output" step → content[] → the type:"video" part. The
  // `output_video` convenience field is SDK-only but shows up on some
  // responses — accept either.
  const modelOutputParts = (interaction.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || []);
  const videoPart = interaction.output_video || modelOutputParts.find((c) => c.type === 'video');
  const textPart = modelOutputParts.find((c) => c.type === 'text' && c.text);

  if (!videoPart) {
    console.error(`${tag} no video in response:`, JSON.stringify(interaction).slice(0, 800));
    const hint = textPart ? ` — model said: ${String(textPart.text).slice(0, 200)}` : '';
    throw new Error(`gemini_omni: no video in response (status: ${interaction.status || 'unknown'})${hint}`);
  }
  console.log(`${tag} interaction ${interaction.id || ''} completed — video part obtained`);

  // 3) Get the bytes: file URI (normal path with delivery:"uri") or inline base64 (≤4MB).
  let videoBuffer;
  if (videoPart.uri) {
    videoBuffer = await downloadVideoFromFilesApi(videoPart.uri, apiKey, tag);
  } else if (videoPart.data) {
    videoBuffer = Buffer.from(videoPart.data, 'base64');
  } else {
    throw new Error('gemini_omni: video part has neither uri nor data');
  }

  // 4) Re-upload to S3 (provider URIs are not permanent) — seedance key convention.
  const contentType = videoPart.mime_type || 'video/mp4';
  const idx = tileIndex != null ? `_${tileIndex}` : '';
  const s3Key = `ai-outputs/${stepId || 'gemini_omni'}${idx}_${Date.now()}_gemini_omni.mp4`;
  const s3Url = await uploadBufferToS3(videoBuffer, s3Key, contentType);
  console.log(`${tag} uploaded to S3: ${s3Url}`);

  // 5) Engine-standard return shape (same as seedance.js — object, NOT a bare string).
  return {
    outputs: [{ label: 'Product Video', type: 'video', url: s3Url }],
    caption: textPart ? String(textPart.text) : '',
    model: modelId,
  };
}

module.exports = { execute };
