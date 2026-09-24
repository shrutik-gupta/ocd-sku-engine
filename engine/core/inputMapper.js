// ═══════════════════════════════════════════════════════════════════════════
// inputMapper — SKU analysis → a template's userInputs.
//
// A Phase 2 template declares what it needs in `inputSchema`. On the user-facing
// path a person fills those fields in by hand. For a SKU Card nobody is there to
// answer, so the analysis answers for them: the card already knows the model's
// gender, the product's story and its texture, because the analyser worked them
// out from the pack.
//
// THIS IS THE WHOLE POINT OF THE CARD. It stops being a document and becomes the
// brief that drives the templates.
//
// Two rules:
//  · Never invent a value a select doesn't offer — fuzzy-match into the schema's
//    own options list, and fall back to the template's declared default.
//  · NEVER supply a field the schema doesn't declare. The schema is the template
//    author's contract; an undeclared field is one the author did not intend
//    that template to receive, and supplying it changes the creative. Casing
//    aliases of a DECLARED key are fine — same value, so the output cannot move.
// ═══════════════════════════════════════════════════════════════════════════

const { schemaOf, isUsable, tagOf } = require('./analysisShape');

const DEFAULT_ASPECT = process.env.SKU_SHOT_ASPECT || '1:1';
const DEFAULT_LANGUAGE = process.env.SKU_SHOT_LANGUAGE || 'English';

const leafText = (x) => {
  if (!x || typeof x !== 'object') return '';
  const v = x.v;
  if (Array.isArray(v)) return v.join(', ');
  return v === null || v === undefined ? '' : String(v);
};

const clean = (s) => {
  const t = String(s || '').trim();
  return (!t || t === '—' || t === '-') ? '' : t;
};

const at = (obj, path) => {
  let n = obj;
  for (const seg of path.split('.')) {
    if (n === null || typeof n !== 'object') return undefined;
    n = Array.isArray(n) ? n[parseInt(seg, 10)] : n[seg];
  }
  return n;
};

const val = (analysis, path) => clean(leafText(at(analysis, path)));

// ─── Option matching ───────────────────────────────────────────────────────
// "South Asian" must land on "Indian / South Asian"; "Female" on "Female".
// Progressive: exact → case-insensitive → containment → token overlap.

function pickOption(candidate, options) {
  const c = clean(candidate);
  if (!c || !Array.isArray(options) || !options.length) return null;

  const exact = options.find((o) => o === c);
  if (exact) return exact;

  const lower = c.toLowerCase();
  const ci = options.find((o) => String(o).toLowerCase() === lower);
  if (ci) return ci;

  const contains = options.find((o) => {
    const ol = String(o).toLowerCase();
    return ol.includes(lower) || lower.includes(ol);
  });
  if (contains) return contains;

  // Token overlap — "South Asian" vs "Indian / South Asian" shares two words.
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  let best = null;
  let bestScore = 0;
  options.forEach((o) => {
    const ot = String(o).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const score = tokens.filter((t) => ot.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = o; }
  });
  return bestScore > 0 ? best : null;
}

/**
 * Age is the awkward one: the analyser writes "22 to 32" or "22-32", the schema
 * offers buckets like "25-34". Use the MIDPOINT of a range, not the low bound —
 * "22-32" describes a cohort centred on 27, and taking 22 lands it in "18-24",
 * which skews every generated model younger than the analysis intended.
 */
function pickAgeOption(candidate, options) {
  const c = clean(candidate);
  if (!c || !Array.isArray(options) || !options.length) return null;

  const direct = pickOption(c, options);
  if (direct) return direct;

  const nums = (c.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter(Number.isFinite);
  if (!nums.length) return null;
  const age = nums.length >= 2
    ? Math.round((nums[0] + nums[1]) / 2)
    : nums[0];

  for (const o of options) {
    const range = String(o).match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range && age >= parseInt(range[1], 10) && age <= parseInt(range[2], 10)) return o;
    const plus = String(o).match(/^(\d+)\s*\+$/);
    if (plus && age >= parseInt(plus[1], 10)) return o;
    const below = String(o).match(/below\s*(\d+)/i);
    if (below && age < parseInt(below[1], 10)) return o;
  }
  return null;
}

// ─── The product description ───────────────────────────────────────────────
// Templates that take a `text` field treat it as the source of truth for all
// written content, and explicitly forbid inventing claims. So this is built ONLY
// from verified and approved material — never from draft claims, and never from
// anything tagged restricted.

function buildProductText(analysis, sku) {
  const parts = [];

  const brand = val(analysis, 'identity.brandName') || sku.brand || '';
  const name = val(analysis, 'identity.productName') || sku.skuName || '';
  const variant = val(analysis, 'identity.variant');
  const qty = val(analysis, 'identity.netQuantity');

  // "Cheat Day Dry Shampoo" already contains the variant "Cheat Day" — repeating
  // it reads as a stutter in generated copy.
  const lname = name.toLowerCase();
  const showVariant = variant && !lname.includes(variant.toLowerCase());
  const title = [brand, name, showVariant ? variant : ''].filter(Boolean).join(' ');
  if (title) parts.push(`${title}${qty ? `, ${qty}` : ''}.`);

  const hero = val(analysis, 'valueProp.heroBenefit');
  if (hero) parts.push(hero.endsWith('.') ? hero : `${hero}.`);

  const benefits = (at(analysis, 'valueProp.benefits') || []).map(leafText).map(clean).filter(Boolean);
  if (benefits.length) parts.push(`Benefits: ${benefits.slice(0, 4).join('; ')}.`);

  const mains = (at(analysis, 'composition.mainElements') || [])
    .map((e) => clean(leafText(e && e.name))).filter(Boolean);
  if (mains.length) parts.push(`Key ingredients: ${mains.slice(0, 4).join(', ')}.`);

  // Approved claims only. `claims.draft` is explicitly "ours until confirmed" and
  // must never reach a generator that will print it onto an image.
  const approved = (at(analysis, 'claims.approved') || []).map(leafText).map(clean).filter(Boolean);
  if (approved.length) parts.push(`Approved claims: ${approved.slice(0, 6).join('; ')}.`);

  const certs = (at(analysis, 'claims.certifications') || []).map(leafText).map(clean).filter(Boolean);
  if (certs.length) parts.push(`Certifications: ${certs.join(', ')}.`);

  const banned = clean(sku.skuInput && sku.skuInput.bannedWords);
  if (banned) parts.push(`Never use these words: ${banned}.`);

  const restricted = (at(analysis, 'claims.restricted') || []).map(leafText).map(clean).filter(Boolean);
  if (restricted.length) parts.push(`Never state or imply: ${restricted.join('; ')}.`);

  return parts.join(' ');
}

// ─── Candidate values, by field key ────────────────────────────────────────
// Keyed lowercase so a template using `AgeGroup` or `ageGroup` both resolve.

function buildCandidates(analysis, sku) {
  return {
    aspectratio: () => DEFAULT_ASPECT,
    language: () => DEFAULT_LANGUAGE,
    gender: () => val(analysis, 'visual.model.gender') || val(analysis, 'consumer.gender'),
    ethnicity: () => val(analysis, 'visual.model.ethnicity'),
    agegroup: () => val(analysis, 'visual.model.ageGroup') || val(analysis, 'consumer.ageGroup'),
    texturetype: () => val(analysis, 'texture.format') || clean(sku.skuInput && sku.skuInput.format),
    text: () => buildProductText(analysis, sku),
    textinput: () => buildProductText(analysis, sku),
    productdescription: () => buildProductText(analysis, sku),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// cat-v1 — the category-prompt shape.
//
// Leaves are { v, s, src } under product.<group>.<field>, and v can be a
// string, a list, an object or a list of objects. Only verified/ai leaves are
// read. The safety rule that `claims.draft` gave v2 is carried by the TAG
// here: claims, free-from lines and certifications reach a generator only
// when they are VERIFIED (read off the pack, or typed by the brand). An `ai`
// claim is a claim nobody printed, and it never gets printed onto an image.
// ═══════════════════════════════════════════════════════════════════════════

// One item of a list, or an object value, as plain text.
function catFlat(x) {
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.map(catFlat).filter(Boolean).join(', ');
  if (typeof x === 'object') return clean(x.name || x.claim || x.text || x.figure || '');
  return clean(String(x));
}

function catLeaf(analysis, path, { verifiedOnly = false } = {}) {
  const n = at(analysis, path);
  if (!isUsable(n)) return null;
  if (verifiedOnly && tagOf(n) !== 'v') return null;
  return n;
}

/** A leaf as text. `key` reads one member of an object value (age, gender…). */
function catText(analysis, path, key, opts) {
  const leaf = catLeaf(analysis, path, opts);
  if (!leaf) return '';
  let v = leaf.v;
  if (key) v = v && typeof v === 'object' && !Array.isArray(v) ? v[key] : '';
  return catFlat(v);
}

/** A list leaf as an array of plain strings. */
function catList(analysis, path, opts) {
  const leaf = catLeaf(analysis, path, opts);
  if (!leaf || !Array.isArray(leaf.v)) return [];
  return leaf.v.map(catFlat).filter(Boolean);
}

// First path that yields text wins — the groups differ per category
// (formula / taste_texture / absorbency / serving / use).
const firstText = (analysis, paths, key) => {
  for (const p of paths) {
    const t = catText(analysis, p, key);
    if (t) return t;
  }
  return '';
};

// "Women", "for her", "Men" → the words template selects actually offer.
function normaliseGender(s) {
  const t = clean(s).toLowerCase();
  if (!t) return '';
  if (/unisex|everyone|all genders|\bboth\b|\ball\b/.test(t)) return 'Unisex';
  const female = /wom[ae]n|female|girls?\b|\bher\b|ladies/.test(t);
  const male = /\bm[ae]n\b|(^|[^e])male|boys?\b|\bhim\b|gents/.test(t);
  if (female && male) return 'Unisex';   // "women and men"
  if (female) return 'Female';
  if (male) return 'Male';
  return clean(s);
}

function buildProductTextCat(analysis, sku) {
  const parts = [];
  const P = 'product.';

  const brand = catText(analysis, `${P}identity.brand`) || sku.brand || '';
  const name = catText(analysis, `${P}identity.product_name`) || sku.skuName || '';
  const variant = catText(analysis, `${P}identity.variant`);
  const qty = catText(analysis, `${P}identity.net_quantity`);

  const lname = name.toLowerCase();
  const showVariant = variant && !lname.includes(variant.toLowerCase());
  const title = [brand, name, showVariant ? variant : ''].filter(Boolean).join(' ');
  if (title) parts.push(`${title}${qty ? `, ${qty}` : ''}.`);

  const hero = firstText(analysis, [`${P}benefits.main_benefit`, `${P}benefits.health_positioning`]);
  if (hero) parts.push(hero.endsWith('.') ? hero : `${hero}.`);

  const benefits = catList(analysis, `${P}benefits.other_benefits`);
  if (benefits.length) parts.push(`Benefits: ${benefits.slice(0, 4).join('; ')}.`);

  const mains = catList(analysis, `${P}ingredients.key_ingredients`);
  if (mains.length) parts.push(`Key ingredients: ${mains.slice(0, 4).join(', ')}.`);

  // Verified only — see the block comment above.
  const claims = catList(analysis, `${P}benefits.printed_claims`, { verifiedOnly: true });
  if (claims.length) parts.push(`Approved claims: ${claims.slice(0, 6).join('; ')}.`);

  const freeFrom = catList(analysis, `${P}ingredients.leaves_out`, { verifiedOnly: true });
  if (freeFrom.length) parts.push(`Free from: ${freeFrom.slice(0, 6).join(', ')}.`);

  const certs = [
    ...catList(analysis, `${P}benefits.certifications`, { verifiedOnly: true }),
    ...catList(analysis, `${P}identity.certifications`, { verifiedOnly: true }), // food keeps them in identity
  ];
  if (certs.length) parts.push(`Certifications: ${[...new Set(certs)].join(', ')}.`);

  const banned = clean(sku.skuInput && sku.skuInput.bannedWords);
  if (banned) parts.push(`Never use these words: ${banned}.`);

  return parts.join(' ');
}

function buildCandidatesCat(analysis, sku) {
  const P = 'product.';
  const audience = `${P}consumer.age_gender_tier_market`;
  return {
    aspectratio: () => DEFAULT_ASPECT,
    language: () => DEFAULT_LANGUAGE,
    gender: () => normaliseGender(catText(analysis, audience, 'gender')),
    ethnicity: () => '',   // no category prompt asks for it — the template default wins
    agegroup: () => catText(analysis, audience, 'age'),
    texturetype: () => firstText(analysis, [
      `${P}formula.texture`, `${P}taste_texture.texture`, `${P}absorbency.texture`,
    ]) || clean(sku.skuInput && sku.skuInput.format),
    text: () => buildProductTextCat(analysis, sku),
    textinput: () => buildProductTextCat(analysis, sku),
    productdescription: () => buildProductTextCat(analysis, sku),
  };
}

/**
 * @returns {{ userInputs: object, notes: string[] }}
 */
function mapAnalysisToInputs({ template, analysis, sku }) {
  const schema = (template && template.inputSchema) || {};
  const candidates = schemaOf(analysis) === 'cat-v1'
    ? buildCandidatesCat(analysis, sku)
    : buildCandidates(analysis, sku);
  const userInputs = {};
  const notes = [];

  for (const [key, def] of Object.entries(schema)) {
    if (!def || def.type === 'file') continue;   // images arrive via inputFiles

    const getter = candidates[key.toLowerCase()];
    const candidate = getter ? getter() : '';

    if (def.type === 'select') {
      const options = Array.isArray(def.options) ? def.options : [];
      const matched = key.toLowerCase() === 'agegroup'
        ? pickAgeOption(candidate, options)
        : pickOption(candidate, options);

      const chosen = matched || def.default || options[0] || '';
      userInputs[key] = chosen;
      notes.push(candidate
        ? `${key}: "${candidate}" → "${chosen}"${matched ? '' : ' (no match, used default)'}`
        : `${key}: nothing in the analysis → "${chosen}" (default)`);
    } else {
      const value = candidate || def.default || '';
      userInputs[key] = value;
      notes.push(`${key}: ${value ? `${value.length} chars` : 'empty'}`);
    }
  }

  // Casing aliases, for DECLARED keys only. The shipped master prompts
  // reference {{userInputs.AspectRatio}} and {{userInputs.TextInput}} while
  // their schemas declare `aspectRatio` and `text`; aliasing lets those
  // sentences resolve instead of being stripped. The value is identical, so
  // this cannot change the creative.
  const alias = {
    aspectRatio: ['AspectRatio'],
    text: ['TextInput'],
    ethnicity: ['Ethnicity'],
    ageGroup: ['AgeGroup'],
    gender: ['Gender'],
    language: ['Language'],
  };
  for (const [from, tos] of Object.entries(alias)) {
    if (userInputs[from] === undefined) continue;
    tos.forEach((to) => { if (userInputs[to] === undefined) userInputs[to] = userInputs[from]; });
  }

  // ── Nothing else is added. This is load-bearing. ──
  //
  // An earlier version also supplied `text`, `textureType` and `language` when
  // the master prompt mentioned them but the schema did not declare them. That
  // looked free — a sentence resolving instead of being stripped — and it was
  // not.
  //
  // BMH121 declares only aspectRatio + imageUpload. Its reference creative is a
  // clean studio pack shot, and the workbook renders it as one, because
  // {{userInputs.text}} resolves to nothing there and finalizePrompt removes it.
  // Injecting 450 characters of benefits and ingredients gave Step 6 ("replace
  // every text element with new product-specific copy") and Step 12 ("apply user
  // instructions relating to campaign direction, typography, marketing copy")
  // real content to act on — and the model built a benefits-panel campaign with
  // a human model in it. A completely different creative from the same template.
  //
  // The schema is the template author's contract. If a field is not declared,
  // the author did not intend that template to receive it.

  return { userInputs, notes };
}

module.exports = { mapAnalysisToInputs, pickOption, pickAgeOption, buildProductText, buildProductTextCat };