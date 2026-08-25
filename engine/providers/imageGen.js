// ═══════════════════════════════════════════════════════════════════════════
// imageGen — one image out, product photo attached as a reference.
//
// The SKU engine does NOT reuse ocd-ai-engine's provider adapters: those are
// built around a template workflow (marketplace records, tile packs, step
// inputs) that has no counterpart here. What IS reused is the hard-won part —
// the product is ATTACHED as a file, never described by URL, and the prompt is
// scrubbed before it leaves.
//
// Provider notes already paid for elsewhere:
//   · gpt-image-2 edits: multipart, `image[]` repeated per reference file.
//     Returns b64_json — there is no url field on this endpoint.
//   · Gemini image: inline_data in, inlineData out. axios REST only, never the
//     @google/generative-ai SDK.
//   · LISTED ≠ CALLABLE — verify any id with a live call before trusting it.
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const TIMEOUT_MS = parseInt(process.env.SKU_SHOT_TIMEOUT_MS, 10) || 240000;

const MODEL_ROUTING = {
  'gpt-image-2': 'openai_image',
  'gemini-2.5-flash-image': 'gemini_image',
};

function providerFor(model) {
  const p = MODEL_ROUTING[model];
  if (p) return p;
  if (/^gpt-image/i.test(model)) return 'openai_image';
  if (/^gemini/i.test(model)) return 'gemini_image';
  throw new Error(`Unknown image model "${model}" — add it to MODEL_ROUTING in imageGen.js`);
}

// ─── OpenAI · gpt-image-2 (images/edits) ───────────────────────────────────

async function callOpenAIImage({ model, prompt, images, size, quality }) {
  // Node 20 has FormData/Blob/fetch natively — no form-data dependency needed.
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  if (quality) form.append('quality', quality);
  form.append('n', '1');

  images.forEach((img, i) => {
    const bytes = Buffer.from(img.base64, 'base64');
    // `image[]` repeated — the edits endpoint takes multiple reference files.
    form.append('image[]', new Blob([bytes], { type: img.mediaType }), `ref-${i}.${img.mediaType.split('/')[1]}`);
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`gpt-image-2 ${res.status}: ${text.slice(0, 600)}`);

  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('gpt-image-2 returned non-JSON'); }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`gpt-image-2 returned no image (${JSON.stringify(data).slice(0, 400)})`);

  return { base64: b64, mediaType: 'image/png', usage: data.usage || null };
}

// ─── Gemini image ──────────────────────────────────────────────────────────

async function callGeminiImage({ model, prompt, images }) {
  const parts = images.map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.base64 } }));
  parts.push({ text: prompt });

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { contents: [{ parts }] },
    { timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
  );

  const out = (res.data?.candidates?.[0]?.content?.parts || [])
    .find((p) => p.inlineData || p.inline_data);
  const blob = out?.inlineData || out?.inline_data;
  if (!blob?.data) throw new Error('Gemini returned no image part');

  return { base64: blob.data, mediaType: blob.mimeType || blob.mime_type || 'image/png', usage: null };
}

// ─── Public ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.prompt   final, already scrubbed
 * @param {string} opts.model
 * @param {Array}  opts.images   [{ base64, mediaType }] — reference photos
 * @param {string} [opts.size]   e.g. "1024x1024"
 * @param {string} [opts.quality]
 * @returns {{ base64, mediaType, provider, model, durationMs }}
 */
async function generateImage({ prompt, model, images = [], size, quality }) {
  if (!prompt) throw new Error('generateImage: prompt is required');
  if (!model) throw new Error('generateImage: model is required');
  if (!images.length) throw new Error('generateImage: at least one reference image is required');

  const provider = providerFor(model);
  const keyVar = provider === 'openai_image' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  if (!process.env[keyVar]) {
    throw new Error(`generateImage: ${keyVar} is not set in ecosystem.config.js (pm2 delete + start after adding it)`);
  }

  const started = Date.now();
  console.log(`[imageGen] ${provider}/${model} · ${images.length} reference image(s) · ${prompt.length} prompt chars`);

  let out;
  try {
    out = provider === 'openai_image'
      ? await callOpenAIImage({ model, prompt, images, size: size || '1024x1024', quality })
      : await callGeminiImage({ model, prompt, images });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 600) : err.message;
    throw new Error(`${provider}/${model} image call failed: ${detail}`);
  }

  const durationMs = Date.now() - started;
  const bytes = Buffer.from(out.base64, 'base64').length;
  console.log(`[imageGen] ${provider}/${model} → ${(bytes / 1024).toFixed(0)}KB in ${durationMs}ms`);

  return { ...out, provider, model, durationMs, bytes };
}

module.exports = { generateImage, MODEL_ROUTING, providerFor };