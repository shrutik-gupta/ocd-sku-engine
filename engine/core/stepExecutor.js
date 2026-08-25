const BASE_PROMPT = `You are a professional commercial product photographer. Generate photorealistic, commercially viable images. Maintain exact product appearance — do not alter the product's shape, colour, material, or features. Output must be print-ready quality with accurate lighting, sharp focus, and no visible AI artefacts.`;

const { composeFinalPrompt } = require('./promptComposer');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const refVideoSigner = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });

async function signRefVideoUrl(url) {
  const m = String(url).match(/^https:\/\/([^.]+)\.s3\.[^/]+\.amazonaws\.com\/(.+)$/);
  if (!m) return url;                       // external url — pass through as-is
  const [, bucket, key] = m;
  try {
    return await getSignedUrl(
      refVideoSigner,
      new GetObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) }),
      { expiresIn: 21600 }
    );
  } catch (err) {
    console.error(`[stepExecutor] failed to presign reference video: ${err.message} — sending bare url`);
    return url;
  }
}
// ─── SESSION 15 — reference-creative wiring + prompt hygiene ──────────────────
// Three related fixes live in this file:
//
// 1. {{templateRefImage}} used to be unknown to the engine. The workbook pasted
//    the raw S3 URL into the master prompt and the token stayed literal in the
//    step prompt. An image model does not fetch URLs, so the reference creative
//    was never seen. Now the token resolves to a ROLE PHRASE in prompt text, and
//    the actual URL is injected into step.inputs so the adapter attaches the file.
//
// 2. Presigned product URLs (hundreds of tokens of X-Amz signature noise) were
//    being shipped inside the prompt. The product is attached as a file; the URL
//    text is pure pollution. Both are now rewritten to role phrases.
//
// 3. Unresolved {{tokens}} used to fall through silently into the final prompt
//    (this is how {{userInputs.TextInput}} vs field key `textinput`, and the
//    self-referential {{masterPrompt}}, reached the image model as literal text).
//    They are now logged loudly and stripped before the call.
//
// ─── MULTI-REFERENCE REVISION (Aug 2026) ──────────────────────────────────────
// A template may now carry up to MAX_TEMPLATE_REFS reference creatives, each an
// { url, role } pair (role optional — "layout", "typography", "colour palette"…).
// The single {{templateRefImage}} token still refers to all of them collectively;
// it pluralises to "images" when more than one is attached. All refs are injected
// as inputs.templateRefImages; slot 1 also mirrors into the legacy
// inputs.templateRefImage key so older adapter copies keep working.
const TEMPLATE_REF_PHRASE = 'the attached REFERENCE CREATIVE image';
const TEMPLATE_REF_VIDEO_PHRASE = 'the reference video [Video1]';
const TEMPLATE_REF_PHRASE_PLURAL = 'the attached REFERENCE CREATIVE images';
const PRODUCT_PHRASE = 'the attached PRODUCT image';
const MAX_TEMPLATE_REFS = 3;

// Any URL carrying an AWS SigV4 signature — i.e. a presigned upload link.
const PRESIGNED_RE = /https?:\/\/\S*?X-Amz-Signature=[^\s,)]+/g;
// Leftover mustache tokens that no context key resolved.
const LEFTOVER_TOKEN_RE = /\{\{[^}]+\}\}/g;

// Normalise every historical row shape into [{ url, role }] (max 3, deduped by
// URL, slot order preserved):
//   referenceImages:    [{ url, role }]   (canonical — what the workbook saves)
//   referenceImageUrls: [url]             (transitional array form)
//   referenceImageUrl:  url               (legacy single — the workbook also
//                                          writes it as a mirror of slot 1, so
//                                          the mirror simply dedupes away here)
function collectTemplateRefs(template) {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry) return;
    const url = typeof entry === 'string' ? entry : entry.url;
    const role = (entry && typeof entry === 'object' && typeof entry.role === 'string') ? entry.role.trim() : '';
    const u = (typeof url === 'string') ? url.trim() : '';
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, role });
  };
  if (Array.isArray(template.referenceImages)) template.referenceImages.forEach(push);
  if (Array.isArray(template.referenceImageUrls)) template.referenceImageUrls.forEach(push);
  push(template.referenceImageUrl);
  return out.slice(0, MAX_TEMPLATE_REFS);
}
function collectTemplateRefVideo(template) {
  const url = typeof template.referenceVideoUrl === 'string' ? template.referenceVideoUrl.trim() : '';
  if (!url) return null;
  const role = typeof template.referenceVideoRole === 'string' ? template.referenceVideoRole.trim() : '';
  return { url, role };
}

// Final pass over an assembled prompt, immediately before it goes to a provider.
// Deliberately belt-and-braces: it also repairs templates already saved in
// DynamoDB with the URL baked in, so those start working from this deploy alone
// without needing a re-save from the workbook.
// `refUrls` may be an array of reference URLs or a single URL string (legacy
// callers) — both are handled.
function finalizePrompt(text, refUrls, stepId, tileIndex, refVideoUrls) {
  let out = text || '';

  const urls = (Array.isArray(refUrls) ? refUrls : [refUrls]).filter(Boolean);
  for (const refUrl of urls) {
    const before = out;
    out = out.split(refUrl).join(TEMPLATE_REF_PHRASE);
    // legacy saves may hold the bare object URL without the query string
    const bare = String(refUrl).split('?')[0];
    if (bare && bare !== refUrl) out = out.split(bare).join(TEMPLATE_REF_PHRASE);
    if (before !== out) {
      console.log(`[stepExecutor] ${stepId} tile ${tileIndex} — rewrote a baked-in reference URL to a role phrase`);
    }
  }

  // Same treatment for the reference VIDEO url — its own phrase, so a video is
  // never described to the model as an image.
  const videoUrls = (Array.isArray(refVideoUrls) ? refVideoUrls : [refVideoUrls]).filter(Boolean);
  for (const refUrl of videoUrls) {
    const before = out;
    out = out.split(refUrl).join(TEMPLATE_REF_VIDEO_PHRASE);
    const bare = String(refUrl).split('?')[0];
    if (bare && bare !== refUrl) out = out.split(bare).join(TEMPLATE_REF_VIDEO_PHRASE);
    if (before !== out) {
      console.log(`[stepExecutor] ${stepId} tile ${tileIndex} — rewrote a baked-in reference VIDEO url to a role phrase`);
    }
  }
  const presigned = out.match(PRESIGNED_RE);
  if (presigned) {
    console.log(`[stepExecutor] ${stepId} tile ${tileIndex} — stripped ${presigned.length} presigned URL(s) from prompt text (images are attached as files)`);
    out = out.replace(PRESIGNED_RE, PRODUCT_PHRASE);
  }

  const leftovers = out.match(LEFTOVER_TOKEN_RE);
  if (leftovers) {
    console.warn(`[stepExecutor] ${stepId} tile ${tileIndex} — STRIPPING ${leftovers.length} unresolved token(s) from the final prompt: ${[...new Set(leftovers)].join(', ')}`);
    out = out.replace(LEFTOVER_TOKEN_RE, '');
  }

  // tidy the whitespace the substitutions leave behind
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Resolve {{variable}} references inside a STRING (interpolation — always returns a string)
function resolveVariables(str, context) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const key = path.trim();
    const value = lookup(key, context);
    if (value === undefined || value === null) {
      // Loud on purpose. A silent pass-through here is how three separate bugs
      // (TextInput casing, AspectRatio casing, self-referential masterPrompt)
      // shipped literal mustache text to the image model.
      console.warn(`[stepExecutor] UNRESOLVED VARIABLE {{${key}}} — nothing in context matches this key (check field-key casing in the workbook)`);
      return match;
    }
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  });
}

// Resolve a value reference. Unlike resolveVariables, if the ENTIRE string is a
// single {{...}} token, this returns the raw resolved value (array/object/string),
// not a stringified version. Used for step.inputs so {{userUpload}} -> array.
function resolveValue(val, context) {
  if (typeof val !== 'string') return val;
  const whole = val.trim().match(/^\{\{([^}]+)\}\}$/);
  if (whole) {
    const resolved = lookup(whole[1].trim(), context);
    return resolved === undefined ? val : resolved;
  }
  // Mixed string with embedded tokens -> string interpolation
  return resolveVariables(val, context);
}

// Walk a dotted path (with optional [index]) through the context object.
function lookup(path, context) {
  const parts = path.split('.');
  let value = context;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      value = value[arrayMatch[1]];
      if (Array.isArray(value)) value = value[parseInt(arrayMatch[2])];
      else return undefined;
    } else {
      value = value[part];
    }
  }
  return value;
}

// Assemble the full Layer 2 master prompt (resolved against context).
function assembleMasterPrompt(template, marketplaceRecord, context) {
  let masterPrompt = '';
  if (template.templateType === 'tile_pack' && marketplaceRecord) {
    masterPrompt = marketplaceRecord.promptInjection + '\n\n' + template.masterPromptSupplement;
  } else {
    // product_replacement and product_video — use masterPromptSupplement directly
    masterPrompt = template.masterPromptSupplement || '';
  }
  return resolveVariables(masterPrompt, context);
}

// Execute a single step
async function executeStep(step, template, marketplaceRecord, context) {
  console.log(`[stepExecutor] Executing step ${step.stepId}: ${step.label}`);

  // ordered array of all uploaded image URLs (front, back, ...)
  const imageUrlList = context.imageUrlList || (context.userUpload ? [context.userUpload] : []);
  // named map { userUpload, userUploadBack, ... }
  const imageUrls = context.imageUrls || (context.userUpload ? { userUpload: context.userUpload } : {});

  // The Section-3.5 creator-only reference creatives (0..3), if this template
  // has any. NOTE: these URLs deliberately do NOT go anywhere near productScan —
  // the analyzer must only ever describe the user's own product.
  const templateRefs = collectTemplateRefs(template);          // [{ url, role }]
  const templateRefUrls = templateRefs.map(r => r.url);
  const templateRefVideo = collectTemplateRefVideo(template);
  // Build the resolution context.
  const resolutionContext = {
    ...imageUrls,
    userUpload: imageUrlList,
    imageUpload: imageUrlList,
    // Resolves to a ROLE PHRASE (pluralised when more than one reference is
    // attached), never a URL. The images themselves are attached to the provider
    // call via resolvedInputs.templateRefImages below.
    templateRefImage: templateRefs.length === 0
      ? ''
      : (templateRefs.length === 1 ? TEMPLATE_REF_PHRASE : TEMPLATE_REF_PHRASE_PLURAL),
    templateRefVideo: !templateRefVideo
      ? ''
      : (templateRefVideo.role
          ? `${TEMPLATE_REF_VIDEO_PHRASE} (use it for: ${templateRefVideo.role})`
          : TEMPLATE_REF_VIDEO_PHRASE),
    userInputs: context.userInputs,
    productContext: context.productContext,
    steps: context.stepOutputs || {}
  };

  // Assemble master prompt (Layer 2)
  const masterPrompt = assembleMasterPrompt(template, marketplaceRecord, resolutionContext);
  resolutionContext.masterPrompt = masterPrompt;

  // ── Prompt Composer mode (opt-in per template) ──────────────────────────────
  // When ON: an AI text call fuses the product analysis + master prompt into a
  // single final image prompt (Call 2). That composed prompt is used for the
  // image call, replacing the BASE+master+tile assembly. When OFF: original path.
  const isParallel = step.executionType === 'parallel' && step.parallelCount > 1;
  const tileCount = isParallel ? step.parallelCount : 1;

  // Resolve each tile's own master/brief text (the per-tile prompt boxes in the
  // Step Builder). Single steps have one prompt; parallel steps have step.prompts[i].
  const tileMasterText = (tileIndex) => {
    if (isParallel) {
      const arr = Array.isArray(step.prompts) ? step.prompts : [];
      const raw = arr[tileIndex] !== undefined ? arr[tileIndex] : (arr[0] || step.prompt || '');
      return resolveVariables(raw, resolutionContext);
    }
    return resolveVariables(step.prompt || '', resolutionContext);
  };

  // composedPrompts[tileIndex] holds the AI-composed final prompt for that tile.
  // For a single step it's just composedPrompts[0]. null entry => fall back to
  // standard assembly for that tile.
  let composedPrompts = new Array(tileCount).fill(null);

  if (template.promptComposerMode) {
    const scanFailed = context.productContext && context.productContext._scanFailed;
    // When the analyzer is OFF there is no analysis to fuse — productContext is
    // absent/empty. The composer can still run (brief-only), but if the analyzer
    // was explicitly disabled we skip composing and fall back to standard assembly,
    // matching the "no analysis at all" semantics.
    const analyzerDisabled = template.analyzerEnabled === false;

    if (scanFailed) {
      // GUARD: scan failed → analysis is garbage. Skip the composer entirely and
      // fall back to standard assembly for all tiles.
      console.error(`[stepExecutor] promptComposerMode ON but SCAN FAILED (${context.productContext._scanError}) — skipping composer, using standard assembly`);
      if (context._composerMeta) {
        context._composerMeta.skipped = true;
        context._composerMeta.reason = `scan failed: ${context.productContext._scanError}`;
      }
    } else if (analyzerDisabled) {
      console.log('[stepExecutor] promptComposerMode ON but analyzer is DISABLED — no analysis to fuse, using standard assembly');
      if (context._composerMeta) {
        context._composerMeta.skipped = true;
        context._composerMeta.reason = 'analyzer disabled (no product analysis to compose from)';
      }
    } else {
      // Compose per tile. For each tile, the "master" fed to the composer is the
      // template-level masterPrompt (shared brief) PLUS that tile's own prompt box.
      // Single step => one tile => composes once (current behaviour).
      console.log(`[stepExecutor] promptComposerMode ON — composing ${tileCount} prompt(s) for step ${step.stepId} (${isParallel ? 'per-tile' : 'single'})`);

      const composeOne = async (tileIndex) => {
        const tileMaster = tileMasterText(tileIndex);
        // Shared template brief + this tile's specific brief.
        const combinedMaster = [masterPrompt, tileMaster].filter(Boolean).join('\n\n');
        try {
          const result = await composeFinalPrompt({
            productContext: context.productContext,
            masterPrompt: combinedMaster,
            composerInstruction: template.composerInstruction,
            composerModel: template.composerModel
          });
          console.log(`[stepExecutor] tile ${tileIndex} composed (${result.length} chars)`);
          return result;
        } catch (err) {
          console.error(`[stepExecutor] tile ${tileIndex} composer FAILED: ${err.message} — that tile falls back to standard assembly`);
          if (context._composerMeta) {
            context._composerMeta.skipped = true;
            context._composerMeta.reason = `composer error (tile ${tileIndex}): ${err.message}`;
          }
          return null;
        }
      };

      // Run all tile composes in parallel.
      composedPrompts = await Promise.all(
        Array.from({ length: tileCount }, (_, i) => composeOne(i))
      );

      // Surface composed prompt(s) for the UI: array for parallel, single string for one tile.
      if (context._composerMeta) {
        if (isParallel) context._composerMeta.composedPrompts = composedPrompts;
        else context._composerMeta.composedPrompt = composedPrompts[0];
      }
    }
  }

  // Resolve step inputs (array-aware: {{userUpload}} -> array, {{userUpload[0]}} -> one)
  const resolvedInputs = {};
  if (step.inputs) {
    for (const [key, val] of Object.entries(step.inputs)) {
      resolvedInputs[key] = resolveValue(val, resolutionContext);
    }
  }

  // The Section-3.5 reference creatives are IMAGE INPUTS, not prompt text.
  // Auto-injected for every step so a template author cannot forget to wire them.
  // Adapters opt in by reading either key:
  //   inputs.templateRefImages — [{ url, role }], ALL refs in slot order (openai_image does)
  //   inputs.templateRefImage  — slot 1's URL alone (legacy string key, kept so
  //                              older adapter copies and nanabanana's one-line
  //                              collectImageUrls() addition keep working)
  // Adapters that ignore both keys are unaffected.
  if (templateRefs.length) {
    resolvedInputs.templateRefImages = templateRefs;
    resolvedInputs.templateRefImage = templateRefs[0].url;
    console.log(`[stepExecutor] ${step.stepId} — injecting ${templateRefs.length} templateRefImage(s) as image inputs: ${templateRefUrls.map(u => u.split('?')[0]).join(', ')}`);
  }
  if (templateRefVideo) {
    resolvedInputs.templateRefVideo = await signRefVideoUrl(templateRefVideo.url);
    resolvedInputs.templateRefVideoRole = templateRefVideo.role || '';
    console.log(`[stepExecutor] ${step.stepId} — injecting templateRefVideo as a video input: ${templateRefVideo.url.split('?')[0]}${templateRefVideo.role ? ` (role: ${templateRefVideo.role})` : ''}`);
  }
  // Load the correct provider adapter
  const adapter = loadAdapter(step.provider);

  // Build one tile's call args. If this tile has a composed prompt, use it verbatim
  // (it already incorporates the analysis + that tile's brief). Otherwise fall back
  // to BASE + master + per-tile prompt.
  const buildArgs = (tileIndex) => {
    let finalPrompt;
    if (composedPrompts[tileIndex]) {
      finalPrompt = composedPrompts[tileIndex];
    } else {
      const rawPrompt = (Array.isArray(step.prompts) && step.prompts.length > 0)
        ? (step.prompts[tileIndex] !== undefined ? step.prompts[tileIndex] : step.prompts[0])
        : (step.prompt || '');
      const perTilePrompt = resolveVariables(rawPrompt, resolutionContext);
      finalPrompt = `${BASE_PROMPT}\n\n${masterPrompt}\n\n${perTilePrompt}`.trim();
    }

    // Applies to BOTH branches — a composed prompt can also carry a baked-in URL,
    // because the composer is fed the master prompt. All stored reference URLs
    // (not just slot 1) are rewritten.
    finalPrompt = finalizePrompt(
      finalPrompt,
      templateRefUrls,
      step.stepId,
      tileIndex,
      templateRefVideo ? [templateRefVideo.url] : []
    );
    console.log(`[stepExecutor] ===== ${step.stepId} tile ${tileIndex} FULL PROMPT =====\n${finalPrompt}\n[stepExecutor] ===== end ${step.stepId} tile ${tileIndex} =====`);

    return {
      prompt: finalPrompt,
      inputs: resolvedInputs,
      imageUrls: imageUrlList,   // every adapter receives the full array
      model: step.model,
      resolution: step.resolution,
      userInputs: context.userInputs,
      quality: step.quality,     // image-quality tier (high|medium|low) for adapters that support it
      stepId: step.stepId,
      tileIndex
    };
  };

  // Execute — single or parallel
  let output;
  if (isParallel) {
    const promises = Array.from({ length: step.parallelCount }, (_, i) =>
      new Promise(resolve => setTimeout(resolve, i * 4000)).then(() => adapter.execute(buildArgs(i)))
    );
    output = await Promise.all(promises);
    console.log(`[stepExecutor] Parallel step ${step.stepId} complete — ${output.length} outputs`);
  } else {
    output = await adapter.execute(buildArgs(0));
    console.log(`[stepExecutor] Single step ${step.stepId} complete`);
  }

  return { [step.outputKey]: output };
}

function loadAdapter(providerId) {
  const adapters = {
    freepik:      require('../providers/freepik'),
    nanabanana:   require('../providers/nanabanana'),
    seedream:     require('../providers/seedream'),
    kling:        require('../providers/kling'),
    runway:       require('../providers/runway'),
    seedance:     require('../providers/seedance'),
    veo3:         require('../providers/veo3'),
    // Session 13 additions:
    openai:       require('../providers/openai'),        // GPT 5.4 (text)
    anthropic:    require('../providers/anthropic'),     // Claude Opus 4.7 (text)
    openai_image: require('../providers/openai_image'),   // GPT Image 2 (image + quality)
    gemini_omni:  require('../providers/gemini_omni')
  };
  const adapter = adapters[providerId];
  if (!adapter) throw new Error(`[stepExecutor] Unknown provider: ${providerId}`);
  return adapter;
}

module.exports = { executeStep, resolveVariables, resolveValue, assembleMasterPrompt, finalizePrompt };
