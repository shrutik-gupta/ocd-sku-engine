// ═══════════════════════════════════════════════════════════════════════════
// DynamoDB access for the SKU engine.
//
//   ProductSKUs — PK userId (username) + SK skuId. The engine APPENDS to the
//                 AI_analysis list and stamps the latest pointers. It never
//                 overwrites user-entered fields.
//   AIJobs      — PK jobId. The poll target. engine:"sku".
//
// Two rules carried in from the other phases:
//   · if_not_exists() is ILLEGAL in a ConditionExpression. It is fine in an
//     UpdateExpression — that is why the append uses it in one place and the
//     plain attribute_exists() guard in the other.
//   · Never write a null onto a sparse-GSI attribute. Omit the field instead.
// ═══════════════════════════════════════════════════════════════════════════

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const SKUS_TABLE = process.env.PRODUCT_SKUS_TABLE || 'ProductSKUs';
const JOBS_TABLE = process.env.AI_JOBS_TABLE || 'AIJobs';
const TEMPLATES_TABLE = process.env.PHASE2_AI_TEMPLATES_TABLE || 'Phase2AITemplates';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ─── SKU ───────────────────────────────────────────────────────────────────

async function getSku(userId, skuId) {
  // No ProjectionExpression on purpose — aliasing silently drops fields, and
  // this row is small enough that the full read is cheaper than the debugging.
  const out = await ddb.send(new GetCommand({
    TableName: SKUS_TABLE,
    Key: { userId, skuId },
  }));
  return out.Item || null;
}

/**
 * Append one entry to AI_analysis and stamp the pointers used for cheap reads.
 * Returns the new list length (= the analysis version number).
 */
async function appendAnalysis(userId, skuId, entry) {
  const now = new Date().toISOString();
  const out = await ddb.send(new UpdateCommand({
    TableName: SKUS_TABLE,
    Key: { userId, skuId },
    UpdateExpression: [
      'SET AI_analysis = list_append(if_not_exists(AI_analysis, :empty), :entry)',
      'latestAnalysisId = :aid',
      'analysisStatus = :status',
      'analysedAt = :now',
      'updatedAt = :now',
    ].join(', '),
    ConditionExpression: 'attribute_exists(skuId)',
    ExpressionAttributeValues: {
      ':empty': [],
      ':entry': [entry],
      ':aid': entry.analysisId,
      ':status': 'complete',
      ':now': now,
    },
    ReturnValues: 'UPDATED_NEW',
  }));
  return (out.Attributes?.AI_analysis || []).length;
}

async function setAnalysisStatus(userId, skuId, status, errorMessage) {
  const values = { ':status': status, ':now': new Date().toISOString() };
  const sets = ['analysisStatus = :status', 'updatedAt = :now'];
  if (errorMessage) {
    sets.push('analysisError = :err');
    values[':err'] = String(errorMessage).slice(0, 900);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: SKUS_TABLE,
      Key: { userId, skuId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(skuId)',
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error('[skuStore] setAnalysisStatus failed:', err.message);
  }
}

// ─── Card shots ────────────────────────────────────────────────────────────
async function upsertCardShots(userId, skuId, results) {
  const cur = await ddb.send(new GetCommand({
    TableName: SKUS_TABLE,
    Key: { userId, skuId },
    ProjectionExpression: 'cardShots',
  }));

  const existing = Array.isArray(cur.Item?.cardShots) ? cur.Item.cardShots : [];
  const byIndex = new Map(existing.map((s) => [s.index, s]));

  results.forEach((r) => {
    // A failed regeneration must not wipe the good shot already sitting there.
    if (r.status === 'failed' && byIndex.has(r.index)) {
      const prev = byIndex.get(r.index);
      if (prev.status === 'complete') {
        byIndex.set(r.index, { ...prev, lastError: r.error, lastFailedAt: r.createdAt });
        return;
      }
    }
    byIndex.set(r.index, r);
  });

  const shots = [...byIndex.values()].sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const now = new Date().toISOString();

  await ddb.send(new UpdateCommand({
    TableName: SKUS_TABLE,
    Key: { userId, skuId },
    UpdateExpression: 'SET cardShots = :s, shotsGeneratedAt = :now, updatedAt = :now',
    ConditionExpression: 'attribute_exists(skuId)',
    ExpressionAttributeValues: { ':s': shots, ':now': now },
  }));

  console.log(`[skuStore] cardShots now holds ${shots.length} entr${shots.length === 1 ? 'y' : 'ies'}`);
  return shots;
}

async function setShotsStatus(userId, skuId, status, errorMessage) {
  const values = { ':status': status, ':now': new Date().toISOString() };
  const sets = ['shotsStatus = :status', 'updatedAt = :now'];
  if (errorMessage) {
    sets.push('shotsError = :err');
    values[':err'] = String(errorMessage).slice(0, 900);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: SKUS_TABLE,
      Key: { userId, skuId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(skuId)',
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error('[skuStore] setShotsStatus failed:', err.message);
  }
}

// ─── Templates ─────────────────────────────────────────────────────────────

async function getTemplate(templateId) {
  const out = await ddb.send(new GetCommand({
    TableName: TEMPLATES_TABLE,
    Key: { templateId },
  }));
  return out.Item || null;
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

/** Write a child job row for runWorkflow to pick up. */
async function putJob(item) {
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(jobId)',
  }));
  return item.jobId;
}

async function getJob(jobId) {
  const out = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }));
  return out.Item || null;
}

async function updateJob(jobId, fields) {
  const names = {};
  const values = { ':now': new Date().toISOString() };
  const sets = ['updatedAt = :now'];
  let i = 0;

  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    const n = `#f${i}`;
    const v = `:v${i}`;
    names[n] = key;          // status / engine are reserved words — always alias
    values[v] = val;
    sets.push(`${n} = ${v}`);
    i++;
  }
  if (!sets.length) return;

  try {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.error(`[skuStore] updateJob ${jobId} failed:`, err.message);
  }
}

/** Stage checkpoint — one line at every stage boundary, like every other engine. */
async function checkpoint(jobId, status, label, extra = {}) {
  console.log(`[sku-engine] ${jobId} → ${status} · ${label}`);
  await updateJob(jobId, { status, currentStepLabel: label, ...extra });
}

module.exports = {
  getSku,
  getTemplate,
  putJob,
  getJob,
  appendAnalysis,
  setAnalysisStatus,
  upsertCardShots,
  setShotsStatus,
  updateJob,
  checkpoint,
  SKUS_TABLE,
  JOBS_TABLE,
};
