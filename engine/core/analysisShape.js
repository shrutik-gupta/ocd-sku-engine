// ═══════════════════════════════════════════════════════════════════════════
// analysisShape — reads both SKU analysis shapes.
//
//   v2      (sku-analyser-v2)   leaf = { v, t }        t: v | a | m | w | r
//                               nine top-level parts (identity, packaging, …)
//   cat-v1  (category prompts)  leaf = { v, s, src }   s: verified | ai | pending
//                               everything under `product.<group>.<field>`
//                               v can be a string, a list, an object, or a
//                               list of objects
//
// Old cards stay v2 forever. New cards are cat-v1 for the categories that have
// a prompt, v2 for the rest. Everything that reads a card goes through here.
//
// Mirrored in app.js (resolveLeaf / applyAnalysisEdits / isLeaf). Change one,
// change both.
// ═══════════════════════════════════════════════════════════════════════════

const CAT_TAG = { verified: 'v', ai: 'a', pending: 'm' };
const BAD_SEG = new Set(['__proto__', 'constructor', 'prototype']);

function schemaOf(analysis) {
  return analysis && typeof analysis === 'object' && analysis.product && typeof analysis.product === 'object'
    ? 'cat-v1'
    : 'v2';
}

function isLeaf(n) {
  return !!n && typeof n === 'object' && !Array.isArray(n) && 'v' in n && ('t' in n || 's' in n);
}

/** Tag as a v2 letter, whatever the shape. */
function tagOf(leaf) {
  if (!isLeaf(leaf)) return null;
  if ('t' in leaf) return leaf.t;
  return CAT_TAG[leaf.s] || 'm';
}

/** Verified or ai. Pending, missing, draft and restricted are never usable. */
function isUsable(leaf) {
  const t = tagOf(leaf);
  return t === 'v' || t === 'a';
}

function resolveLeaf(root, path) {
  let node = root;
  for (const seg of String(path).split('.')) {
    if (BAD_SEG.has(seg)) return null;
    if (node === null || typeof node !== 'object') return null;
    node = Array.isArray(node) ? node[parseInt(seg, 10)] : node[seg];
  }
  return isLeaf(node) ? node : null;
}

/**
 * The edit overlay, applied to a copy. A human edit makes the leaf verified in
 * either shape, and keeps the AI's value so the card can offer "revert".
 */
function applyAnalysisEdits(analysis, edits) {
  if (!analysis || !edits || typeof edits !== 'object') return analysis;
  const out = JSON.parse(JSON.stringify(analysis));

  for (const [path, edit] of Object.entries(edits)) {
    if (!edit || typeof edit !== 'object') continue;
    const leaf = resolveLeaf(out, path);
    if (!leaf) continue; // the shape changed — drop the edit silently

    leaf.aiValue = leaf.v;
    if ('t' in leaf) {
      leaf.aiTag = leaf.t;
      leaf.t = 'v';
    } else {
      leaf.aiTag = leaf.s;
      leaf.aiSrc = leaf.src;
      leaf.s = 'verified';
      leaf.src = 'typed';
    }
    leaf.v = edit.v;
    leaf.edited = true;
    leaf.editedAt = edit.editedAt || null;
  }
  return out;
}

module.exports = { schemaOf, isLeaf, tagOf, isUsable, resolveLeaf, applyAnalysisEdits };