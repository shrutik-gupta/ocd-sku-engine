// ═══════════════════════════════════════════════════════════════════════════
// SKU ANALYSIS ROUTES
//
// Paste as one block into ocddevlocal/src/app.js, directly after the existing
// PRODUCT SKUs block.
//
// Requires, already present in app.js for the SKU block:
//   verifyToken, _dynamo, PRODUCT_SKUS_TABLE, AI_JOBS_TABLE,
//   GetCommand, PutCommand, UpdateCommand, QueryCommand, uuidv4
//
// New Lambda env var:  SKU_JOBS_SQS_QUEUE_URL
// New IAM inline policy on ocdLambdaRole53404fd1-dev:  sku-sqs-send
//     sqs:SendMessage on arn:aws:sqs:ap-south-1:539247475467:ocd-sku-jobs-queue
//
// NEVER run the analysis in Lambda. It is a 3-minute vision call: it would blow
// both the 29s API Gateway cap and the point of having an engine.
// ═══════════════════════════════════════════════════════════════════════════

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const _sqsSku = new SQSClient({ region: 'ap-south-1' });

const SKU_ANALYSIS_QUEUE = process.env.SKU_JOBS_SQS_QUEUE_URL;
const SKU_ANALYSIS_MAX_IMAGES = 6;

// A run in one of these states is still in flight — don't queue a second.
const SKU_ANALYSIS_BUSY = ['queued', 'processing', 'stage_images', 'stage_analyser', 'stage_persist'];

// ─── START AN ANALYSIS ─────────────────────────────────────────────────────
// POST /api/skus/:skuId/analyse   { imageKeys?: [s3Key], force?: bool }

app.post('/api/skus/:skuId/analyse', verifyToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { skuId } = req.params;
    const { imageKeys, force } = req.body || {};

    if (!SKU_ANALYSIS_QUEUE) {
      return res.status(500).json({ error: 'SKU analysis queue is not configured' });
    }

    const cur = await _dynamo.send(new GetCommand({
      TableName: PRODUCT_SKUS_TABLE,
      Key: { userId: username, skuId },
    }));
    if (!cur.Item) return res.status(404).json({ error: 'SKU not found' });

    const sku = cur.Item;
    const images = Array.isArray(sku.images) ? sku.images : [];

    // ── Gate: the analyser needs something real to read ──
    const missing = [];
    const input = sku.skuInput || {};
    if (!String(input.brand || sku.brand || '').trim()) missing.push('brand name');
    if (!String(input.name || sku.skuName || '').trim()) missing.push('product name');
    if (!sku.category) missing.push('category');
    if (!images.length) missing.push('at least one product image');
    if (missing.length) {
      return res.status(400).json({ error: 'Not enough to analyse yet', missing });
    }

    if (!force && SKU_ANALYSIS_BUSY.includes(sku.analysisStatus)) {
      return res.status(409).json({
        error: 'An analysis is already running for this SKU',
        jobId: sku.analysisJobId || null,
        status: sku.analysisStatus,
      });
    }

    // Keys the caller pinned must actually belong to this SKU.
    const owned = new Set(images.map((im) => im.s3Key));
    const keys = (Array.isArray(imageKeys) && imageKeys.length ? imageKeys : images.map((im) => im.s3Key))
      .filter((k) => owned.has(k))
      .slice(0, SKU_ANALYSIS_MAX_IMAGES);
    if (!keys.length) return res.status(400).json({ error: 'None of those images belong to this SKU' });

    const jobId = `sku_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    const jobItem = {
      jobId,
      engine: 'sku',
      userId: username,
      skuId,
      skuName: sku.skuName || '',          // denormalised — survives SKU deletion
      status: 'queued',
      currentStepLabel: 'Queued…',
      imageKeys: keys,
      createdAt: now,
      updatedAt: now,
      // parentJobId deliberately OMITTED, not set to null — a null on a sparse
      // GSI key attribute is a type mismatch that fails the write.
    };

    await _dynamo.send(new PutCommand({
      TableName: AI_JOBS_TABLE,
      Item: jobItem,
      ConditionExpression: 'attribute_not_exists(jobId)',
    }));

    await _dynamo.send(new UpdateCommand({
      TableName: PRODUCT_SKUS_TABLE,
      Key: { userId: username, skuId },
      UpdateExpression: 'SET analysisStatus = :s, analysisJobId = :j, updatedAt = :now REMOVE analysisError',
      ConditionExpression: 'attribute_exists(skuId)',
      ExpressionAttributeValues: { ':s': 'queued', ':j': jobId, ':now': now },
    }));

    await _sqsSku.send(new SendMessageCommand({
      QueueUrl: SKU_ANALYSIS_QUEUE,
      MessageBody: JSON.stringify({ jobId, userId: username, skuId, imageKeys: keys }),
    }));

    console.log(`[SKU] queued analysis ${jobId} for ${skuId} (${keys.length} images)`);
    res.json({ success: true, jobId, imageCount: keys.length });
  } catch (err) {
    console.error('[SKU] analyse error:', err);
    res.status(500).json({ error: 'Failed to start analysis', details: err.message });
  }
});

// ─── POLL ──────────────────────────────────────────────────────────────────
// GET /api/skus/:skuId/analysis/status?jobId=...
// Terminal status is "complete" — never "completed".

app.get('/api/skus/:skuId/analysis/status', verifyToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { skuId } = req.params;
    let jobId = req.query.jobId;

    if (!jobId) {
      const cur = await _dynamo.send(new GetCommand({
        TableName: PRODUCT_SKUS_TABLE,
        Key: { userId: username, skuId },
      }));
      if (!cur.Item) return res.status(404).json({ error: 'SKU not found' });
      jobId = cur.Item.analysisJobId;
      if (!jobId) return res.json({ success: true, status: 'none' });
    }

    const out = await _dynamo.send(new GetCommand({
      TableName: AI_JOBS_TABLE,
      Key: { jobId },
    }));
    if (!out.Item) return res.status(404).json({ error: 'Job not found' });
    if (out.Item.userId !== username) return res.status(403).json({ error: 'Not your job' });
    if (out.Item.skuId !== skuId) return res.status(400).json({ error: 'That job is for a different SKU' });

    const job = out.Item;
    res.json({
      success: true,
      jobId,
      status: job.status,
      currentStepLabel: job.currentStepLabel || '',
      analysisId: job.analysisId || null,
      analysisVersion: job.analysisVersion || null,
      promptVersion: job.promptVersion || null,
      model: job.model || null,
      jobDurationMs: job.jobDurationMs || null,
      errorMessage: job.errorMessage || null,
    });
  } catch (err) {
    console.error('[SKU] analysis status error:', err);
    res.status(500).json({ error: 'Failed to fetch status', details: err.message });
  }
});

// ─── READ AN ANALYSIS ──────────────────────────────────────────────────────
// GET /api/skus/:skuId/analysis           → latest
// GET /api/skus/:skuId/analysis?all=1     → every version, newest first (no bodies)
// GET /api/skus/:skuId/analysis?id=an_... → one specific version

app.get('/api/skus/:skuId/analysis', verifyToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { skuId } = req.params;

    const cur = await _dynamo.send(new GetCommand({
      TableName: PRODUCT_SKUS_TABLE,
      Key: { userId: username, skuId },
    }));
    if (!cur.Item) return res.status(404).json({ error: 'SKU not found' });

    const list = Array.isArray(cur.Item.AI_analysis) ? cur.Item.AI_analysis : [];
    if (!list.length) {
      return res.json({ success: true, analysis: null, status: cur.Item.analysisStatus || 'none' });
    }

    if (req.query.all) {
      // Metadata only — a 6-version history with bodies would blow the 6MB
      // Lambda payload cap on a big SKU.
      const versions = list
        .map((a, i) => ({
          version: i + 1,
          analysisId: a.analysisId,
          promptVersion: a.promptVersion,
          model: a.model,
          createdAt: a.createdAt,
          durationMs: a.durationMs,
          analysisBytes: a.analysisBytes || null,
          offloaded: !!a.analysisS3Key,
        }))
        .reverse();
      return res.json({ success: true, count: versions.length, versions });
    }

    const wanted = req.query.id
      ? list.find((a) => a.analysisId === req.query.id)
      : list[list.length - 1];
    if (!wanted) return res.status(404).json({ error: 'Analysis not found' });

    // Offloaded bodies live in S3; hand back the key and let the caller fetch
    // through the existing signing path rather than proxying it here.
    res.json({
      success: true,
      status: cur.Item.analysisStatus || 'complete',
      version: list.indexOf(wanted) + 1,
      analysisId: wanted.analysisId,
      promptVersion: wanted.promptVersion,
      model: wanted.model,
      createdAt: wanted.createdAt,
      imageManifest: wanted.imageManifest || [],
      inputsSnapshot: wanted.inputsSnapshot || null,
      analysis: wanted.analysis || null,
      analysisS3Key: wanted.analysisS3Key || null,
    });
  } catch (err) {
    console.error('[SKU] get analysis error:', err);
    res.status(500).json({ error: 'Failed to fetch analysis', details: err.message });
  }
});
