const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const openaiImage = require('../providers/openai_image');

// ─── core/editRunner.js ───────────────────────────────────────── Phase 2 ─
// EDIT is not a workflow. It never loads the template, never scans the product,
// never runs the composer and never touches a step. It is one call:
//
//     one finished output image  +  the user's instruction  →  one new image
//
// It exists so a user who got five good options and one that missed can fix the
// one without paying for — or risking — a whole new run.
//
// REGENERATE, by contrast, needs nothing in this file. It is an ordinary job
// with a parentJobId, so it flows straight through runWorkflow as normal and
// its outputs ARE the complete new set.
//
// ── THE SNAPSHOT INVARIANT ───────────────────────────────────────────────────
// Every job writes the COMPLETE set as it stands after that job — so an edit
// merges its one new image over the source run's finalOutputs and stores the
// whole array. "What does this set look like now" is then one row lookup, and
// GET /api/ai-jobs/:jobId/set replays the lineage only to survive out-of-order
// completions.

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

// Hardcoded on purpose — an edit is a fixed capability, not an authored one.
// If this ever becomes per-template, it belongs in the workbook next to the
// generator config, not scattered here.
const EDIT_MODEL = 'gpt-image-2';
const EDIT_QUALITY = 'high';
const EDIT_RESOLUTION = '1k';

const RATIO_RE = /^\d{1,2}:\d{1,2}$/;

// The instruction alone would be read as "draw me this", not "change this".
// The guard is what keeps an edit an edit.
function buildEditPrompt(instruction) {
  return `Edit the attached image as follows:\n\n${instruction}\n\n` +
    'Everything else in the image stays exactly as it is — the same product, the same ' +
    'composition, the same camera angle, the same lighting, the same background and the ' +
    'same text, unless the change described above genuinely requires otherwise. Do not ' +
    'redraw or restyle the product. Do not re-lay-out the frame. Do not add, remove or ' +
    're-word any text that is not named above. This is a revision of the attached ' +
    'photograph, not a new photograph of the same subject.';
}

async function updateJobStatus(jobId, updates) {
  const expressions = [], names = {}, values = {};
  for (const [key, val] of Object.entries(updates)) {
    expressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = val;
  }
  await dynamo.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function loadJob(jobId) {
  const r = await dynamo.send(new GetCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
  }));
  if (!r.Item) throw new Error(`Job not found: ${jobId}`);
  return r.Item;
}

// The set this edit is amending. Lambda stamps sourceJobId as the latest
// COMPLETED job in the lineage; parentJobId is the fallback.
async function loadSourceOutputs(job) {
  const id = job.sourceJobId || job.parentJobId;
  if (!id) throw new Error('edit job has no sourceJobId or parentJobId');
  let src;
  try {
    src = await loadJob(id);
  } catch (e) {
    throw new Error(`could not load source run ${id}: ${e.message}`);
  }
  const outs = Array.isArray(src.finalOutputs) ? src.finalOutputs : [];
  if (!outs.length) throw new Error(`source run ${id} has no outputs to edit`);
  return { sourceJobId: id, outputs: outs };
}

// ── EDIT ─────────────────────────────────────────────────────────────────────
async function runEdit(jobId, job, startTime) {
  console.log(`[editRunner] ===== Starting edit ${jobId} =====`);

  const instruction = String(job.editInstruction || '').trim();
  if (!instruction) throw new Error('edit job has no editInstruction');

  const sourceUrl = job.editSourceUrl;
  if (!sourceUrl) throw new Error('edit job has no editSourceUrl');

  const idx = parseInt(job.variantIndex, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`variantIndex ${job.variantIndex} is not a valid output index`);
  }

  const { sourceJobId, outputs } = await loadSourceOutputs(job);
  if (!outputs[idx]) {
    throw new Error(`output ${idx} does not exist on source run ${sourceJobId} (it has ${outputs.length})`);
  }
  if (outputs[idx].type === 'video') {
    throw new Error('that output is a video — only images can be edited');
  }

  // The source image's true ratio isn't knowable from the URL, so it comes off
  // the parent's own aspectRatio input, which nearly every Phase 2 preset
  // carries. Falls back to square. (Reading the real dimensions with sharp
  // before the call would be strictly better — worth doing if a non-square
  // template ever comes back letterboxed.)
  const aspectRatio = RATIO_RE.test(String(job.editAspectRatio || '')) ? job.editAspectRatio : '1:1';

  await updateJobStatus(jobId, {
    status: 'processing',
    currentTier: 1,
    totalTiers: 1,
    currentStepLabel: 'Applying your change...',
  });

  console.log(`[editRunner] editing output ${idx} of ${sourceJobId} · ${aspectRatio} · "${instruction.slice(0, 80)}"`);

  const result = await openaiImage.execute({
    prompt: buildEditPrompt(instruction),
    imageUrls: [sourceUrl],
    model: EDIT_MODEL,
    quality: EDIT_QUALITY,
    resolution: EDIT_RESOLUTION,
    inputs: { aspectRatio },
    stepId: `edit_${jobId}`,
    tileIndex: idx,
  });

  const url = result?.outputs?.[0]?.url;
  if (!url) throw new Error('the image model returned no image');

  // Snapshot invariant — carry the WHOLE set forward with this one slot swapped.
  const finalOutputs = outputs.map((o, i) => (
    i === idx ? { ...o, type: 'image', url } : { ...o }
  ));

  const jobDurationMs = Date.now() - startTime;
  await updateJobStatus(jobId, {
    status: 'completed',            // Phase 2 says "completed" — tools says "complete"
    finalOutputs,
    jobDurationMs,
    completedAt: new Date().toISOString(),
    currentStepLabel: 'Complete',
  });

  console.log(`[editRunner] ===== Edit ${jobId} COMPLETE — output ${idx} in ${jobDurationMs}ms =====\n`);
  return { success: true, jobId, jobDurationMs };
}

// Entry point used by workflowRunner's dispatch. Owns its own failure handling
// so the caller stays a one-liner.
async function editJob(jobId, job) {
  const startTime = Date.now();
  try {
    return await runEdit(jobId, job, startTime);
  } catch (err) {
    console.error(`[editRunner] ===== Edit ${jobId} FAILED =====`);
    console.error(err);
    await updateJobStatus(jobId, {
      status: 'failed',
      errorMessage: err.message,
      completedAt: new Date().toISOString(),
      currentStepLabel: 'Failed',
    }).catch(e => console.error('[editRunner] Failed to update error status:', e));
    return { success: false, jobId, error: err.message };
  }
}

module.exports = { editJob };
