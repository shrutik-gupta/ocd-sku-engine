// ═══════════════════════════════════════════════════════════════════════════
// ocd-sku-engine · worker.js
//
// 24/7 long-poller of ocd-sku-jobs-queue. One job at a time. Never crashes on
// a bad job — a failure marks the job and keeps polling.
// ═══════════════════════════════════════════════════════════════════════════

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { runSkuAnalysis } = require('./engine/core/skuRunner');
const { runSkuShots } = require('./engine/core/shotRunner');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const QUEUE_URL = process.env.SKU_JOBS_SQS_QUEUE_URL || '';
const EXPECTED_QUEUE = 'ocd-sku-jobs-queue';

// ── Boot guard: this engine may ONLY ever poll its own queue. ──
// Replaces the two-grep ritual the other engines rely on. A copied ecosystem
// file pointing at ocd-ai-jobs-queue / ocd-ecomm-jobs-queue / ocd-tools-jobs-queue
// dies here instead of quietly stealing that queue's jobs.
if (!QUEUE_URL) {
  console.error('[sku-engine] FATAL: SKU_JOBS_SQS_QUEUE_URL is not set. Check ecosystem.config.js.');
  process.exit(1);
}
if (!QUEUE_URL.endsWith(`/${EXPECTED_QUEUE}`)) {
  console.error(`[sku-engine] FATAL: refusing to poll "${QUEUE_URL}".`);
  console.error(`[sku-engine] This engine only polls a queue ending in /${EXPECTED_QUEUE}.`);
  process.exit(1);
}

const sqs = new SQSClient({ region: REGION });

let running = false;
let shuttingDown = false;

async function handleMessage(msg) {
  let payload;
  try {
    payload = JSON.parse(msg.Body);
  } catch (err) {
    console.error('[sku-engine] unparseable message body, dropping:', msg.Body?.slice(0, 300));
    return true; // delete it — a malformed message will never parse
  }

  const jobId = payload.jobId || '(no jobId)';
  const kind = payload.kind || 'analysis';
  console.log(`[sku-engine] ── job ${jobId} · ${kind} · sku ${payload.skuId} · user ${payload.userId}`);

  try {
    const run = kind === 'shots' ? runSkuShots : runSkuAnalysis;
    const result = await run(payload);
    console.log(`[sku-engine] ✓ job ${jobId} ${result.status} in ${result.durationMs}ms`);
  } catch (err) {
    // runSkuAnalysis marks the job itself; this is the last-resort net.
    console.error(`[sku-engine] ✗ job ${jobId} threw past its own handler:`, err && err.message);
  }
  return true; // always delete — retries are an explicit user action, not SQS redelivery
}

async function poll() {
  if (running || shuttingDown) return;
  running = true;
  try {
    const out = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 1800, // must match the queue setting
    }));

    const messages = out.Messages || [];
    for (const msg of messages) {
      const done = await handleMessage(msg);
      if (done) {
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle,
        }));
      }
    }
  } catch (err) {
    console.error('[sku-engine] poll error:', err && err.message);
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    running = false;
  }
}

process.on('SIGTERM', () => { shuttingDown = true; console.log('[sku-engine] SIGTERM — draining'); });
process.on('SIGINT', () => { shuttingDown = true; console.log('[sku-engine] SIGINT — draining'); });
process.on('unhandledRejection', (err) => {
  console.error('[sku-engine] unhandledRejection (staying up):', err && err.message);
});

console.log('══════════════════════════════════════════════════════');
console.log('[sku-engine] started');
console.log(`[sku-engine] Region : ${REGION}`);
console.log(`[sku-engine] Queue  : ${QUEUE_URL}`);
console.log(`[sku-engine] SKUs   : ${process.env.PRODUCT_SKUS_TABLE}`);
console.log(`[sku-engine] Jobs   : ${process.env.AI_JOBS_TABLE}`);
console.log(`[sku-engine] Model  : ${process.env.SKU_ANALYSER_MODEL}`);
console.log('══════════════════════════════════════════════════════');

setInterval(poll, 1000);
poll();
