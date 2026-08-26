// ═══════════════════════════════════════════════════════════════════════════
// skuRunner — orchestrates the SKU analysis.
//
//   1  load          SKU row + job sanity
//   2  collectImages read up to N images from S3, downscale, base64
//   3  runAnalyser   one vision call with the fixed prompt
//   4  persist       append to ProductSKUs.AI_analysis, complete the job
//
// The stages are EXPORTED individually on purpose (the Phase 3/4 convention):
// re-running just the analyser on an existing SKU, or on a new prompt version,
// is then pure routing rather than a rebuild.
//
// Nothing in here is allowed to crash the process. Every failure path marks the
// job and the SKU row, then returns.
// ═══════════════════════════════════════════════════════════════════════════

const { agentCall } = require('./agentCall');
const { readImageForVision, putAnalysisJson } = require('./s3Reader');
const { parseJsonLoose } = require('./jsonParse');
const store = require('./skuStore');
const { buildAnalyserPrompt, PROMPT_VERSION } = require('../prompts/skuAnalyser');

const MAX_IMAGES = parseInt(process.env.SKU_IMAGE_MAX_COUNT, 10) || 6;
const INLINE_MAX = parseInt(process.env.SKU_ANALYSIS_INLINE_MAX, 10) || 150000;
const ANALYSIS_PREFIX = process.env.SKU_ANALYSIS_PREFIX || 'sku-analysis';
const DEFAULT_MODEL = process.env.SKU_ANALYSER_MODEL || 'claude-opus-4-7';

// ─── 1 · load ──────────────────────────────────────────────────────────────

async function loadContext(job) {
  const { userId, skuId } = job;
  if (!userId || !skuId) throw new Error('Job is missing userId or skuId');

  const sku = await store.getSku(userId, skuId);
  if (!sku) throw new Error(`SKU ${skuId} not found for user ${userId}`);

  const images = Array.isArray(sku.images) ? sku.images : [];
  if (!images.length) throw new Error('This SKU has no images — nothing to analyse');

  return {
    sku,
    images,
    // The job may pin a subset/order; otherwise take the row's own order.
    selectedKeys: Array.isArray(job.imageKeys) && job.imageKeys.length
      ? job.imageKeys
      : images.map((im) => im.s3Key),
  };
}

// ─── 2 · collectImages ─────────────────────────────────────────────────────

async function collectImages(ctx) {
  const byKey = Object.fromEntries(ctx.images.map((im) => [im.s3Key, im]));
  const keys = ctx.selectedKeys.filter((k) => byKey[k]).slice(0, MAX_IMAGES);

  if (!keys.length) throw new Error('None of the requested image keys exist on this SKU');

  const attached = [];
  const manifest = [];

  for (let i = 0; i < keys.length; i++) {
    const meta = byKey[keys[i]];
    // v2 rows carry slotName ("Back of Pack"); v1 rows only have the role enum.
    const slot = meta.slotName || meta.slot || meta.role || 'detail';
    try {
      const img = await readImageForVision(meta.s3Key, meta.mimeType);
      attached.push({
        ...img,
        // The per-image role manifest — the session-16 lesson. Without it the
        // model has N anonymous images and no idea which one is the back panel.
        caption: `IMAGE ${i + 1} of ${keys.length} — slot: ${slot}`,
      });
      manifest.push({ position: i + 1, slot, s3Key: meta.s3Key, bytes: img.bytes });
    } catch (err) {
      // One unreadable image must not sink the analysis.
      console.error(`[skuRunner] could not read ${meta.s3Key}:`, err.message);
      manifest.push({ position: i + 1, slot, s3Key: meta.s3Key, error: err.message });
    }
  }

  if (!attached.length) {
    throw new Error('Could not read any image from S3 — check s3:GetObject on the EC2 instance role');
  }

  const totalMb = (attached.reduce((s, i) => s + i.bytes, 0) / 1048576).toFixed(2);
  console.log(`[skuRunner] attached ${attached.length} image(s), ${totalMb} MB after downscale`);

  return { attached, manifest };
}

// ─── 3 · runAnalyser ───────────────────────────────────────────────────────

async function runAnalyser({ sku, attached, manifest, model }) {
  // brand / skuName / mrp / internalSkuId / aiNotes are TOP-LEVEL columns on the
  // SKU row, not members of skuInput. Passing only skuInput meant the analyser
  // never saw the MRP the user had typed and correctly reported it as missing.
  const identity = {
    brandName: sku.brand || '',
    productName: sku.skuName || '',
    mrp: sku.mrp === null || sku.mrp === undefined || sku.mrp === '' ? '' : `${sku.currency || 'INR'} ${sku.mrp}`,
    internalSkuCode: sku.internalSkuId || '',
    // Legacy free-text the owner wrote for us. Still the best instruction we get.
    ownerNotes: sku.aiNotes || '',
  };

  const { system, prompt, attachments } = buildAnalyserPrompt({
    category: sku.category,
    productType: sku.productType || sku.subcategory,
    identity,
    skuInput: sku.skuInput || {},
    imageManifest: manifest.map(({ position, slot }) => ({ position, slot })),
  });

  const out = await agentCall({
    system,
    prompt,
    model: model || DEFAULT_MODEL,
    images: attached,
    attachments,
  });

  const parsed = parseJsonLoose(out.text);
  if (!parsed.ok) {
    console.error('[skuRunner] analyser output was not JSON:', parsed.error);
    console.error('[skuRunner] raw head:', parsed.raw);
    throw new Error(`Analyser did not return JSON — ${parsed.error}`);
  }
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new Error('Analyser returned JSON, but not an object at the top level');
  }

  return { analysis: parsed.value, call: out };
}

// ─── 4 · persist ───────────────────────────────────────────────────────────

async function persistAnalysis({ job, sku, analysis, call, manifest }) {
  const analysisId = `an_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const serialised = JSON.stringify(analysis);

  const entry = {
    analysisId,
    jobId: job.jobId,
    promptVersion: PROMPT_VERSION,
    model: call.model,
    provider: call.provider,
    status: 'complete',
    createdAt: new Date().toISOString(),
    durationMs: call.durationMs,
    usage: call.usage || null,
    imageManifest: manifest,
    // Snapshot of what the analysis was built FROM. When the user later edits
    // the SKU, this is how you know the card is stale.
    inputsSnapshot: {
      category: sku.category || null,
      productType: sku.productType || sku.subcategory || null,
      identity: {
        brandName: sku.brand || '',
        productName: sku.skuName || '',
        mrp: sku.mrp ?? null,
        currency: sku.currency || 'INR',
        internalSkuCode: sku.internalSkuId || '',
      },
      skuInput: sku.skuInput || {},
    },
  };

  // DynamoDB items cap at 400KB and this row also carries the image list, so a
  // large analysis goes to S3 with a pointer left behind.
  if (serialised.length > INLINE_MAX) {
    const key = `${ANALYSIS_PREFIX}/${job.userId}/${job.skuId}/${analysisId}.json`;
    const put = await putAnalysisJson(key, analysis);
    entry.analysis = null;
    entry.analysisS3Key = put.s3Key;
    entry.analysisBytes = put.bytes;
    console.log(`[skuRunner] analysis ${put.bytes}B > ${INLINE_MAX}B — offloaded to ${key}`);
  } else {
    entry.analysis = analysis;
    entry.analysisS3Key = null;
    entry.analysisBytes = serialised.length;
  }

  const version = await store.appendAnalysis(job.userId, job.skuId, entry);
  console.log(`[skuRunner] AI_analysis now has ${version} entr${version === 1 ? 'y' : 'ies'}`);

  return { analysisId, version, entry };
}

// ─── the run ───────────────────────────────────────────────────────────────

/**
 * @param {object}  job
 * @param {object} [opts]
 * @param {boolean}[opts.terminal=true]  when false, the caller owns the job's
 *        final status. Used by cardRunner, which chains shots onto the same job
 *        and must not let the analysis mark it complete halfway through.
 */
async function runSkuAnalysis(job, opts = {}) {
  const terminal = opts.terminal !== false;
  const started = Date.now();
  const { jobId, userId, skuId } = job;

  try {
    await store.checkpoint(jobId, 'processing', 'Opening your SKU');
    const ctx = await loadContext(job);

    await store.checkpoint(jobId, 'stage_images', 'Reading your product images');
    const { attached, manifest } = await collectImages(ctx);
    await store.updateJob(jobId, { imageManifest: manifest });

    await store.checkpoint(jobId, 'stage_analyser', 'Analysing the product');
    const { analysis, call } = await runAnalyser({
      sku: ctx.sku,
      attached,
      manifest,
      model: job.model,
    });

    await store.checkpoint(jobId, 'stage_persist', 'Saving your analysis');
    const saved = await persistAnalysis({ job, sku: ctx.sku, analysis, call, manifest });

    const durationMs = Date.now() - started;
    await store.updateJob(jobId, {
      ...(terminal ? { status: 'complete', currentStepLabel: 'Done', completedAt: new Date().toISOString() } : {}),
      analysisId: saved.analysisId,
      analysisVersion: saved.version,
      promptVersion: PROMPT_VERSION,
      model: call.model,
      analysisDurationMs: durationMs,
      errorMessage: null,
    });

    return { status: 'complete', analysisId: saved.analysisId, analysis, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err && err.message ? err.message : String(err);
    console.error(`[skuRunner] job ${jobId} failed after ${durationMs}ms:`, message);

    await store.updateJob(jobId, {
      status: 'failed',
      currentStepLabel: 'Failed',
      errorMessage: message.slice(0, 900),
      jobDurationMs: durationMs,
      completedAt: new Date().toISOString(),
    });
    if (userId && skuId) await store.setAnalysisStatus(userId, skuId, 'failed', message);

    return { status: 'failed', durationMs, error: message };
  }
}

module.exports = {
  runSkuAnalysis,
  loadContext,
  collectImages,
  runAnalyser,
  persistAnalysis,
};
