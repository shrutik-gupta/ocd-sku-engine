// ═══════════════════════════════════════════════════════════════════════════
// shotRunner — the three SKU Card shots.
//
// Reads the shot directions out of the latest analysis (WITH the user's edits
// applied — an edited direction is the one that gets sent), attaches the SKU's
// own product photos, and fires three generations in parallel.
//
// Carried over from ocd-ai-engine/stepExecutor.js, each for a reason:
//   · BASE_PROMPT — the photorealism/fidelity preamble.
//   · PRODUCT_PHRASE — the prompt refers to the attached file by role instead
//     of describing the product, so the model can't redraw the logo wrong.
//   · finalizePrompt() — strips presigned URLs and unresolved {{tokens}} before
//     the call. Both have shipped to a provider as literal text before.
//   · A 4s stagger between parallel launches rather than a simultaneous burst.
//
// What is deliberately NOT carried over: workflow steps, marketplace records,
// tile packs, per-step adapters. There is no template here — one prompt, one
// product, three times.
// ═══════════════════════════════════════════════════════════════════════════

const { generateImage } = require('../providers/imageGen');
const { readImageForVision, putShotImage } = require('./s3Reader');
const store = require('./skuStore');

const BASE_PROMPT = `You are a professional commercial product photographer. Generate a photorealistic, commercially viable image. Maintain the exact product appearance — do not alter the product's shape, colour, material, label, logo or text. Output must be print-ready quality with accurate lighting, sharp focus, and no visible AI artefacts.`;

const PRODUCT_PHRASE = 'the attached PRODUCT image';
const PRESIGNED_RE = /https?:\/\/\S*?X-Amz-Signature=[^\s,)]+/g;
const LEFTOVER_TOKEN_RE = /\{\{[^}]+\}\}/g;

const SHOT_COUNT = 3;
const STAGGER_MS = parseInt(process.env.SKU_SHOT_STAGGER_MS, 10) || 4000;
const MODEL = process.env.SKU_SHOT_MODEL || 'gpt-image-2';
const SIZE = process.env.SKU_SHOT_SIZE || '1024x1024';
const QUALITY = process.env.SKU_SHOT_QUALITY || 'high';
const SHOT_PREFIX = process.env.SKU_SHOT_PREFIX || 'sku-card-shots';
const MAX_REFS = parseInt(process.env.SKU_SHOT_MAX_REFS, 10) || 2;

// ─── Analysis reading ──────────────────────────────────────────────────────
// Same overlay merge the Lambda does on read. Duplicated rather than shared
// because the engine and the API are separate deployables — but the shape is
// one thing, so if one changes the other must.

function resolveLeaf(root, path) {
  let node = root;
  for (const seg of String(path).split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = Array.isArray(node) ? node[parseInt(seg, 10)] : node[seg];
  }
  return node && typeof node === 'object' && 't' in node ? node : null;
}

function applyAnalysisEdits(analysis, edits) {
  if (!analysis || !edits || typeof edits !== 'object') return analysis;
  const out = JSON.parse(JSON.stringify(analysis));
  for (const [path, edit] of Object.entries(edits)) {
    const leaf = resolveLeaf(out, path);
    if (!leaf || !edit || typeof edit !== 'object') continue;
    leaf.v = edit.v;
    leaf.t = 'v';
    leaf.edited = true;
  }
  return out;
}

const leafText = (x) => {
  if (!x || typeof x !== 'object') return '';
  const v = x.v;
  if (Array.isArray(v)) return v.join(', ');
  return v === null || v === undefined ? '' : String(v);
};

// ─── Prompt assembly ───────────────────────────────────────────────────────

function finalizePrompt(text, shotIndex) {
  let out = text || '';

  const presigned = out.match(PRESIGNED_RE);
  if (presigned) {
    console.log(`[shotRunner] shot ${shotIndex} — stripped ${presigned.length} presigned URL(s) from prompt text (the product is attached as a file)`);
    out = out.replace(PRESIGNED_RE, PRODUCT_PHRASE);
  }

  const leftovers = out.match(LEFTOVER_TOKEN_RE);
  if (leftovers) {
    console.warn(`[shotRunner] shot ${shotIndex} — STRIPPING ${leftovers.length} unresolved token(s): ${[...new Set(leftovers)].join(', ')}`);
    out = out.replace(LEFTOVER_TOKEN_RE, '');
  }

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The direction the analyser wrote already says "the product shown in the
 * reference image". Everything else here is guard rails: what must not change,
 * and what must not be said.
 */
function buildShotPrompt({ shot, index, sku, analysis }) {
  const direction = leafText(shot.direction);
  const name = leafText(analysis?.identity?.productName) || sku.skuName || 'the product';
  const brand = leafText(analysis?.identity?.brandName) || sku.brand || '';

  const banned = String(sku.skuInput?.bannedWords || '')
    .split(',').map((w) => w.trim()).filter(Boolean);

  const rules = [
    `The product is ${brand ? `${brand} ` : ''}${name}. It is supplied as ${PRODUCT_PHRASE} — reproduce it exactly as shown.`,
    'Do not redraw, re-letter or re-style any logo, wordmark, label copy or legal text. Keep every printed element pixel-faithful to the attached photograph.',
    'Do not add any text, badge, price, sticker or watermark that is not already on the product.',
  ];
  if (banned.length) {
    rules.push(`Never depict or imply these words anywhere in the image: ${banned.join(', ')}.`);
  }

  return finalizePrompt(
    [BASE_PROMPT, rules.join(' '), direction].filter(Boolean).join('\n\n'),
    index
  );
}

// ─── Stages ────────────────────────────────────────────────────────────────

async function loadShotContext(job) {
  const { userId, skuId } = job;
  if (!userId || !skuId) throw new Error('Job is missing userId or skuId');

  const sku = await store.getSku(userId, skuId);
  if (!sku) throw new Error(`SKU ${skuId} not found for user ${userId}`);

  const list = Array.isArray(sku.AI_analysis) ? sku.AI_analysis : [];
  if (!list.length) throw new Error('Build the SKU card before generating its shots');

  const latest = list[list.length - 1];
  const analysis = applyAnalysisEdits(latest.analysis || {}, sku.analysisEdits || {});
  const shots = Array.isArray(analysis.shots) ? analysis.shots.slice(0, SHOT_COUNT) : [];
  if (!shots.length) throw new Error('The analysis contains no shot directions');

  const images = Array.isArray(sku.images) ? sku.images : [];
  if (!images.length) throw new Error('This SKU has no product images to work from');

  return { sku, analysis, shots, images, analysisId: latest.analysisId };
}

/**
 * The reference photos. Front-of-pack first — it is the one that carries the
 * label the model must not redraw. Capped, because every extra reference costs
 * tokens on all three calls.
 */
async function collectShotRefs(ctx) {
  const ordered = [...ctx.images].sort((a, b) => (a.slotIndex ?? 99) - (b.slotIndex ?? 99));
  const picked = ordered.slice(0, MAX_REFS);

  const refs = [];
  for (const im of picked) {
    try {
      refs.push(await readImageForVision(im.s3Key, im.mimeType));
    } catch (err) {
      console.error(`[shotRunner] could not read ${im.s3Key}: ${err.message}`);
    }
  }
  if (!refs.length) {
    throw new Error('Could not read any product image from S3 — check s3:GetObject on the EC2 instance role');
  }
  console.log(`[shotRunner] ${refs.length} reference image(s): ${picked.map((i) => i.slotName || i.role).join(', ')}`);
  return refs;
}

async function runOneShot({ job, ctx, refs, index }) {
  const shot = ctx.shots[index];
  const name = leafText(shot.name) || `Shot ${index + 1}`;
  const prompt = buildShotPrompt({ shot, index, sku: ctx.sku, analysis: ctx.analysis });

  console.log(`[shotRunner] ===== shot ${index} "${name}" FULL PROMPT =====\n${prompt}\n[shotRunner] ===== end shot ${index} =====`);

  const out = await generateImage({ prompt, model: MODEL, images: refs, size: SIZE, quality: QUALITY });

  const s3Key = `${SHOT_PREFIX}/${job.userId}/${job.skuId}/${Date.now()}_${index}.png`;
  await putShotImage(s3Key, Buffer.from(out.base64, 'base64'), out.mediaType);

  return {
    index,
    name,
    // BARE object key — never a presigned URL. Signed at read time by the API.
    s3Key,
    status: 'complete',
    prompt,
    model: out.model,
    provider: out.provider,
    bytes: out.bytes,
    durationMs: out.durationMs,
    analysisId: ctx.analysisId,
    createdAt: new Date().toISOString(),
  };
}

// ─── The run ───────────────────────────────────────────────────────────────

async function runSkuShots(job) {
  const started = Date.now();
  const { jobId, userId, skuId } = job;

  try {
    await store.checkpoint(jobId, 'processing', 'Opening your SKU card');
    const ctx = await loadShotContext(job);

    await store.checkpoint(jobId, 'stage_images', 'Reading your product images');
    const refs = await collectShotRefs(ctx);

    // Only the shots asked for; default is all three.
    const wanted = Array.isArray(job.shotIndexes) && job.shotIndexes.length
      ? job.shotIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < ctx.shots.length)
      : ctx.shots.map((_, i) => i);

    await store.checkpoint(jobId, 'stage_shots', `Generating ${wanted.length} shot${wanted.length === 1 ? '' : 's'}`);

    // Staggered launch, not a simultaneous burst — three identical calls landing
    // in the same millisecond is how you find a provider's rate limit.
    const results = await Promise.all(wanted.map((index, n) =>
      new Promise((r) => setTimeout(r, n * STAGGER_MS))
        .then(() => runOneShot({ job, ctx, refs, index }))
        .catch((err) => {
          // One failed shot must not lose the other two.
          console.error(`[shotRunner] shot ${index} FAILED: ${err.message}`);
          return {
            index,
            name: leafText(ctx.shots[index]?.name) || `Shot ${index + 1}`,
            status: 'failed',
            error: String(err.message).slice(0, 500),
            createdAt: new Date().toISOString(),
          };
        })
    ));

    await store.checkpoint(jobId, 'stage_persist', 'Saving your shots');
    await store.upsertCardShots(userId, skuId, results);

    const ok = results.filter((r) => r.status === 'complete').length;
    const durationMs = Date.now() - started;

    // All three failing is a failed job; a partial result is still a result.
    const terminal = ok === 0 ? 'failed' : 'complete';
    await store.updateJob(jobId, {
      status: terminal,
      currentStepLabel: ok === results.length ? 'Done' : `${ok} of ${results.length} generated`,
      shotsGenerated: ok,
      shotsRequested: results.length,
      jobDurationMs: durationMs,
      completedAt: new Date().toISOString(),
      errorMessage: ok === 0 ? (results[0]?.error || 'Every shot failed') : null,
    });
    await store.setShotsStatus(userId, skuId, terminal, ok === 0 ? results[0]?.error : null);

    console.log(`[shotRunner] job ${jobId} ${terminal} — ${ok}/${results.length} shots in ${durationMs}ms`);
    return { status: terminal, generated: ok, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err && err.message ? err.message : String(err);
    console.error(`[shotRunner] job ${jobId} failed after ${durationMs}ms:`, message);

    await store.updateJob(jobId, {
      status: 'failed',
      currentStepLabel: 'Failed',
      errorMessage: message.slice(0, 900),
      jobDurationMs: durationMs,
      completedAt: new Date().toISOString(),
    });
    if (userId && skuId) await store.setShotsStatus(userId, skuId, 'failed', message);

    return { status: 'failed', durationMs, error: message };
  }
}

module.exports = {
  runSkuShots,
  loadShotContext,
  collectShotRefs,
  runOneShot,
  buildShotPrompt,
  finalizePrompt,
};