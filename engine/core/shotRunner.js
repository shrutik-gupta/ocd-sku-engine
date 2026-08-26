// ═══════════════════════════════════════════════════════════════════════════
// shotRunner — the three SKU Card shots, rendered by real Phase 2 templates.
//
// The template IS the recipe. It carries the master prompt, the reference
// creative, the input schema, the workflow steps and the output schema. This
// module reimplements none of that — it creates three child AIJobs rows and
// hands each to the vendored runWorkflow(), exactly as the user-facing path does.
//
// All this module contributes:
//   1. Deciding WHICH three templates.
//   2. Filling their userInputs from the SKU analysis instead of from a person
//      (see inputMapper).
//   3. Pointing inputFiles at the SKU's own product photos.
//   4. Collecting finalOutputs back onto the SKU row as cardShots.
//
// NO CREDITS. Child jobs are written straight to AIJobs by the engine and never
// pass through the Lambda create route, which is where creditCost is deducted.
//
// parentJobId is deliberately NOT set on the children. That attribute is a
// sparse GSI key carrying Phase 2's regenerate/edit lineage; putting SKU
// children on it would surface them inside a user's template job history.
// `skuJobId` carries the link instead.
// ═══════════════════════════════════════════════════════════════════════════

const { randomUUID } = require('crypto');
const { runWorkflow } = require('./workflowRunner');
const { mapAnalysisToInputs } = require('./inputMapper');
const { presignForRead } = require('./s3Reader');
const store = require('./skuStore');

// Fixed for now. Later this becomes per-category, or chosen by the analyser.
const DEFAULT_TEMPLATES = ['BMCB105', 'BMCB121', 'BMTL103'];
const SHOT_TEMPLATES = (process.env.SKU_SHOT_TEMPLATES || DEFAULT_TEMPLATES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const STAGGER_MS = parseInt(process.env.SKU_SHOT_STAGGER_MS, 10) || 4000;
const MAX_PRODUCT_IMAGES = parseInt(process.env.SKU_SHOT_MAX_REFS, 10) || 2;

// ─── Analysis reading (overlay-aware) ──────────────────────────────────────
// The user's edits are the point of the card being editable — a corrected
// product name or model gender must reach the template, not just the screen.

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

  const images = Array.isArray(sku.images) ? sku.images : [];
  if (!images.length) throw new Error('This SKU has no product images to work from');

  return { sku, analysis, images, analysisId: latest.analysisId };
}

/**
 * inputFiles as a KEYED MAP, which workflowRunner prefers — `imageUpload` is the
 * file field all three schemas declare, and aliasUploadKeys mirrors it to
 * `userUpload` so both token spellings resolve.
 *
 * Presigned rather than bare: openai_image would fall back to the instance role
 * on a 403, but that wastes an HTTPS round-trip per image per shot. These URLs
 * are consumed within seconds.
 */
async function buildInputFiles(ctx) {
  const ordered = [...ctx.images].sort((a, b) => (a.slotIndex ?? 99) - (b.slotIndex ?? 99));
  const picked = ordered.slice(0, MAX_PRODUCT_IMAGES);

  const inputFiles = {};
  for (let i = 0; i < picked.length; i++) {
    const url = await presignForRead(picked[i].s3Key, 6 * 3600);
    inputFiles[i === 0 ? 'imageUpload' : `imageUpload${i + 1}`] = url;
  }
  if (!Object.keys(inputFiles).length) throw new Error('Could not presign any product image');

  console.log(`[shotRunner] ${picked.length} product image(s): ${picked.map((p) => p.slotName || p.role).join(', ')}`);
  return inputFiles;
}

async function runOneShot({ job, ctx, inputFiles, index }) {
  const templateId = SHOT_TEMPLATES[index];
  if (!templateId) throw new Error(`No template configured for shot ${index}`);

  const template = await store.getTemplate(templateId);
  if (!template) throw new Error(`Template ${templateId} not found in Phase2AITemplates`);

  const { userInputs, notes } = mapAnalysisToInputs({ template, analysis: ctx.analysis, sku: ctx.sku });
  console.log(`[shotRunner] shot ${index} · ${templateId} "${template.name}" — userInputs from analysis:`);
  notes.forEach((n) => console.log(`[shotRunner]     ${n}`));

  const childJobId = `skushot_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  // The child is a NORMAL template job — runWorkflow reads it exactly as it
  // reads a user's. The extra fields are only for our own bookkeeping.
  await store.putJob({
    jobId: childJobId,
    engine: 'sku',
    kind: 'shot_child',
    skuJobId: job.jobId,
    userId: job.userId,
    skuId: job.skuId,
    shotIndex: index,
    templateId,
    templateName: template.name || templateId,
    inputFiles,
    userInputs,
    status: 'queued',
    currentStepLabel: 'Queued…',
    createdAt: now,
    updatedAt: now,
  });

  const result = await runWorkflow(childJobId, {});
  if (!result || !result.success) {
    throw new Error(result && result.error ? result.error : 'Workflow failed');
  }

  // runWorkflow wrote finalOutputs onto the child row — read them back rather
  // than duplicating assembleFinalOutputs here.
  const child = await store.getJob(childJobId);
  const outputs = Array.isArray(child && child.finalOutputs) ? child.finalOutputs : [];
  const image = outputs.find((o) => o.url && (o.type || 'image') === 'image');
  if (!image) throw new Error(`${templateId} finished with no image output`);

  return {
    index,
    name: image.label || template.name || `Shot ${index + 1}`,
    // A permanent public URL from s3Uploader (ai-outputs/...), not a bare key —
    // unlike SKU product images, which are private and signed on read.
    url: image.url,
    status: 'complete',
    templateId,
    templateName: template.name || templateId,
    childJobId,
    userInputs,
    analysisId: ctx.analysisId,
    durationMs: result.jobDurationMs || null,
    createdAt: new Date().toISOString(),
  };
}

// ─── The run ───────────────────────────────────────────────────────────────

/**
 * @param {object}  job
 * @param {object} [opts]
 * @param {boolean}[opts.terminal=true]  when false the caller owns the job's
 *        final status (see cardRunner).
 */
async function runSkuShots(job, opts = {}) {
  const terminal = opts.terminal !== false;
  const started = Date.now();
  const { jobId, userId, skuId } = job;

  try {
    await store.checkpoint(jobId, 'processing', 'Opening your SKU card');
    const ctx = await loadShotContext(job);

    await store.checkpoint(jobId, 'stage_images', 'Preparing your product images');
    const inputFiles = await buildInputFiles(ctx);

    const wanted = Array.isArray(job.shotIndexes) && job.shotIndexes.length
      ? job.shotIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < SHOT_TEMPLATES.length)
      : SHOT_TEMPLATES.map((_, i) => i);

    await store.checkpoint(jobId, 'stage_shots', `Generating ${wanted.length} shot${wanted.length === 1 ? '' : 's'}`);

    // Staggered, not simultaneous: three gpt-image-2 calls landing together is
    // how you find the rate limit.
    const results = await Promise.all(wanted.map((index, n) =>
      new Promise((r) => setTimeout(r, n * STAGGER_MS))
        .then(() => runOneShot({ job, ctx, inputFiles, index }))
        .catch((err) => {
          // One failed template must not lose the other two.
          console.error(`[shotRunner] shot ${index} (${SHOT_TEMPLATES[index]}) FAILED: ${err.message}`);
          return {
            index,
            name: `Shot ${index + 1}`,
            templateId: SHOT_TEMPLATES[index],
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
    const terminalStatus = ok === 0 ? 'failed' : 'complete';
    const firstError = (results.find((r) => r.status === 'failed') || {}).error || null;

    await store.updateJob(jobId, {
      ...(terminal ? {
        status: terminalStatus,
        currentStepLabel: ok === results.length ? 'Done' : `${ok} of ${results.length} generated`,
        completedAt: new Date().toISOString(),
      } : {}),
      shotsGenerated: ok,
      shotsRequested: results.length,
      shotsDurationMs: durationMs,
      ...(terminal && ok === 0 ? { errorMessage: firstError || 'Every shot failed' } : {}),
    });
    await store.setShotsStatus(userId, skuId, terminalStatus, ok === 0 ? firstError : null);

    console.log(`[shotRunner] job ${jobId} ${terminalStatus} — ${ok}/${results.length} shots in ${durationMs}ms`);
    return { status: terminalStatus, generated: ok, requested: results.length, durationMs, error: firstError };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err && err.message ? err.message : String(err);
    console.error(`[shotRunner] job ${jobId} failed after ${durationMs}ms:`, message);

    if (terminal) {
      await store.updateJob(jobId, {
        status: 'failed',
        currentStepLabel: 'Failed',
        errorMessage: message.slice(0, 900),
        jobDurationMs: durationMs,
        completedAt: new Date().toISOString(),
      });
    }
    if (userId && skuId) await store.setShotsStatus(userId, skuId, 'failed', message);

    return { status: 'failed', generated: 0, requested: 0, durationMs, error: message };
  }
}

module.exports = { runSkuShots, loadShotContext, buildInputFiles, runOneShot, SHOT_TEMPLATES };