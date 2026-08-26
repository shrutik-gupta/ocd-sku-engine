// ═══════════════════════════════════════════════════════════════════════════
// cardRunner — "Create SKU Card" is now ONE job.
//
// Analysis and the three shots run back to back under a single jobId, so the
// user sees one loading screen and gets a finished card. Neither stage writes
// the terminal status itself (both are called with { terminal: false }) — this
// module owns it, because a job that says "complete" after the analysis would
// send the UI to a card whose images are still generating.
//
// Shots are best-effort. An analysis that succeeded is a card worth showing
// even if every image failed: the nine parts are the substance, the three shots
// are the garnish. So the job is `complete` whenever the analysis landed, and
// carries shotsGenerated so the UI can say what actually arrived.
// ═══════════════════════════════════════════════════════════════════════════

const { runSkuAnalysis } = require('./skuRunner');
const { runSkuShots } = require('./shotRunner');
const store = require('./skuStore');

async function runSkuCard(job) {
  const started = Date.now();
  const { jobId, userId, skuId } = job;

  // ── Stage A · the analysis ──
  const analysis = await runSkuAnalysis(job, { terminal: false });
  if (analysis.status !== 'complete') {
    // runSkuAnalysis already wrote the failed status and the SKU row.
    return analysis;
  }

  // ── Stage B · the three shots ──
  let shots = { status: 'skipped', generated: 0, requested: 0 };
  try {
    shots = await runSkuShots({ ...job, shotIndexes: null }, { terminal: false });
  } catch (err) {
    // runSkuShots catches its own errors, so this is belt-and-braces only.
    console.error(`[cardRunner] shots threw past their own handler: ${err.message}`);
    shots = { status: 'failed', generated: 0, requested: 0, error: err.message };
  }

  const durationMs = Date.now() - started;
  const label = shots.generated === shots.requested && shots.requested > 0
    ? 'Done'
    : `Card ready · ${shots.generated} of ${shots.requested || 3} images`;

  await store.updateJob(jobId, {
    status: 'complete',              // NOT "completed" — the poller convention
    currentStepLabel: label,
    shotsGenerated: shots.generated,
    shotsRequested: shots.requested,
    jobDurationMs: durationMs,
    completedAt: new Date().toISOString(),
    // The analysis is what makes the card; a partial image run is a note, not a
    // failure. Surfaced so the UI can mention it without calling the job failed.
    shotsWarning: shots.generated < (shots.requested || 3)
      ? (shots.error || `${shots.generated} of ${shots.requested || 3} images generated`)
      : null,
  });

  console.log(
    `[cardRunner] job ${jobId} complete in ${durationMs}ms — ` +
    `analysis ${analysis.analysisId}, ${shots.generated}/${shots.requested} shots`
  );

  return {
    status: 'complete',
    analysisId: analysis.analysisId,
    shotsGenerated: shots.generated,
    durationMs,
  };
}

module.exports = { runSkuCard };