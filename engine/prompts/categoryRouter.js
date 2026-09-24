// ═══════════════════════════════════════════════════════════════════════════
// categoryRouter — which analyser prompt reads this SKU.
//
// Eight category prompts live in ./categories as .md files, copied as-is.
// Edit the .md, bump its "### vX.Y" line, then pm2 restart ocd-sku-engine
// (a plain restart is fine — no env changed). The version line is read from
// the file and stamped on every AI_analysis entry.
//
// No match → null → the caller uses the legacy sku-analyser-v2 prompt.
// That covers apparel, tech, kitchenware and the non-cleaning part of
// home-living, which have no category prompt yet.
//
// ROLLOUT FLAG — SKU_CATEGORY_PROMPTS in ecosystem.config.js:
//   ''  or unset          → off, every SKU uses v2 (today's behaviour)
//   'all'                 → every category prompt is live
//   'skincare,food'       → only these keys are live
// Changing it needs pm2 delete + start (env change).
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'categories');

const FILES = {
  skincare:        'OCD_Skincare_Analyzer_Prompt_v1.md',
  haircare:        'OCD_Haircare_Analyzer_Prompt_v1.md',
  makeup:          'OCD_Makeup_Analyzer_Prompt_v1.md',
  personalcare:    'OCD_PersonalCare_Analyzer_Prompt_v1.md',
  personalhygiene: 'OCD_PersonalHygiene_Analyzer_Prompt_v1.md',
  supplements:     'OCD_Supplements_Analyzer_Prompt_v1.md',
  food:            'OCD_Food_Analyzer_Prompt_v1.md',
  homecare:        'OCD_Home_Care_Analyzer_Prompt_v1.md',
};

// ─── Load once at boot ─────────────────────────────────────────────────────
// A missing file is logged loudly and that key falls back to v2. It never
// stops the engine: v2 is today's working behaviour.

const PROMPTS = {};
for (const [key, file] of Object.entries(FILES)) {
  try {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    const m = text.match(/^###\s*v(\d+(?:\.\d+)*)/m);
    PROMPTS[key] = {
      key,
      file,
      text,
      promptVersion: `sku-cat-${key}-v${m ? m[1] : '1'}`,
    };
  } catch (err) {
    console.error(`[categoryRouter] ⚠️ could not read ${file} — "${key}" falls back to v2: ${err.message}`);
  }
}

function enabledKeys() {
  const raw = String(process.env.SKU_CATEGORY_PROMPTS || '').trim().toLowerCase();
  if (!raw) return new Set();
  if (raw === 'all') return new Set(Object.keys(FILES));
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

// ─── Beauty is five prompts, so productType decides ────────────────────────
// Exact names first (the list served by /api/skus-meta), then keywords for
// free-typed product types. No match inside beauty → skincare, the general
// beauty prompt.

const BEAUTY_TYPES = {
  // Skincare
  'face serum': 'skincare', 'face cream': 'skincare', 'face wash': 'skincare',
  'cleanser': 'skincare', 'micellar water': 'skincare', 'toner': 'skincare',
  'sunscreen': 'skincare', 'face mask': 'skincare', 'under eye cream': 'skincare',
  'lip balm': 'skincare',
  // Haircare
  'shampoo': 'haircare', 'conditioner': 'haircare', 'hair oil': 'haircare', 'hair serum': 'haircare',
  // Makeup
  'lipstick': 'makeup', 'foundation': 'makeup', 'kajal': 'makeup',
  'mascara': 'makeup', 'eyeliner': 'makeup', 'compact': 'makeup',
  // Personal care
  'body lotion': 'personalcare', 'body wash': 'personalcare', 'fragrance': 'personalcare',
  'deodorant': 'personalcare', 'soap': 'personalcare', 'hand wash': 'personalcare',
  'toothpaste': 'personalcare', 'shaving cream': 'personalcare',
  // Personal hygiene
  'sanitary pads': 'personalhygiene', 'panty liners': 'personalhygiene',
  'menstrual cup': 'personalhygiene', 'intimate wash': 'personalhygiene',
  'baby diapers': 'personalhygiene', 'baby wipes': 'personalhygiene',
  'adult diapers': 'personalhygiene',
};

// Order matters: "hair removal" is personal care, not haircare.
const BEAUTY_KEYWORDS = [
  [/\b(pads?|liners?|tampons?|menstrual|period|diapers?|nappy|nappies|intimate|baby wipes?|adult briefs?)\b/, 'personalhygiene'],
  [/\b(shav\w*|razors?|hair removal|wax strips?|depilator\w*)\b/, 'personalcare'],
  [/\b(shampoo|conditioner|hair|scalp)\b/, 'haircare'],
  [/\b(lipstick|lip gloss|lip liner|lip tint|kajal|kohl|mascara|eye ?liner|eye ?shadow|foundation|concealer|blush|bronzer|highlighter|primer|compact|nail (polish|paint|lacquer)|makeup)\b/, 'makeup'],
  [/\b(deo\w*|antiperspirant|perfume|fragrance|body (wash|lotion|butter|oil|mist)|soap|hand ?wash|sanitis\w*|sanitiz\w*|tooth\w*|mouthwash|talc)\b/, 'personalcare'],
];

// Home care is only the cleaning / fragrance / pest part of Home & Living.
const HOMECARE_RE = /\b(clean\w*|detergent|laundry|fabric (softener|conditioner)|dish ?wash\w*|floor|toilet|bathroom|disinfect\w*|air freshener|home fragrance|room spray|pest|mosquito|insect\w*|repellent|cockroach)\b/;

function routeKey(categoryId, productType) {
  const cat = String(categoryId || '').trim().toLowerCase();
  const type = String(productType || '').trim().toLowerCase();

  if (cat === 'supp') return 'supplements';
  if (cat === 'food') return 'food';

  if (cat === 'beauty') {
    if (BEAUTY_TYPES[type]) return BEAUTY_TYPES[type];
    for (const [re, key] of BEAUTY_KEYWORDS) if (re.test(type)) return key;
    return 'skincare';
  }

  if (cat === 'home-living' || cat === 'home') {
    return HOMECARE_RE.test(type) ? 'homecare' : null;
  }

  return null; // apparel, tech, kitchenware, other → legacy v2
}

/**
 * @returns {{ key, file, text, promptVersion } | null}
 *          null → use the legacy v2 prompt.
 */
function pickCategoryAnalyser({ categoryId, productType }) {
  const key = routeKey(categoryId, productType);
  if (!key) return null;
  if (!enabledKeys().has(key)) return null;
  return PROMPTS[key] || null;
}

module.exports = { pickCategoryAnalyser, routeKey, enabledKeys, PROMPTS, FILES };