// ═══════════════════════════════════════════════════════════════════════════
// Balanced-brace JSON extraction.
//
// GPT-5.x and Opus both like to wrap JSON in prose or code fences even when
// told not to. JSON.parse() on the raw string fails; slicing on the first "{"
// and last "}" breaks on nested braces inside strings. This walks the string
// tracking string/escape state, so it returns the first COMPLETE top-level
// object regardless of what surrounds it.
// ═══════════════════════════════════════════════════════════════════════════

function stripFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractBalanced(text, open = '{', close = '}') {
  const s = String(text || '');
  const start = s.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unterminated — almost always a truncated response
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string, raw: string }}
 */
function parseJsonLoose(text) {
  const cleaned = stripFences(text);
  if (!cleaned) return { ok: false, error: 'Model returned empty content', raw: '' };

  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (_) { /* fall through */ }

  const block = extractBalanced(cleaned);
  if (!block) {
    return {
      ok: false,
      error: 'No complete JSON object in the response (likely truncated — raise SKU_ANALYSER_MAX_TOKENS)',
      raw: cleaned.slice(0, 2000),
    };
  }

  try {
    return { ok: true, value: JSON.parse(block) };
  } catch (err) {
    return { ok: false, error: `JSON.parse failed: ${err.message}`, raw: block.slice(0, 2000) };
  }
}

module.exports = { parseJsonLoose, extractBalanced, stripFences };
