// ═══════════════════════════════════════════════════════════════════════════
// agentCall — "fixed prompt + attached images + attachment blocks → text".
//
// Same contract as the Phase 3/4 agentCall.js, with vision as a first-class
// input because the SKU analyser reads packs, not just words.
//
// Provider gotchas already paid for elsewhere, encoded here:
//   · OpenAI newer models: max_completion_tokens (NOT max_tokens), NO custom
//     temperature, generous caps — reasoning tokens count against the cap and
//     a small budget returns EMPTY content with finish_reason "length".
//   · Anthropic Opus: NO temperature param.
//   · Images are ATTACHED as base64 blocks. Never a URL in prompt text.
//   · LISTED ≠ CALLABLE — every id here must pass a live call first.
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const TIMEOUT_MS = parseInt(process.env.SKU_ANALYSER_TIMEOUT_MS, 10) || 180000;
const MAX_TOKENS = parseInt(process.env.SKU_ANALYSER_MAX_TOKENS, 10) || 16384;

// One place to fix a bad id.
const MODEL_ROUTING = {
  'claude-opus-4-7': 'anthropic',
  'claude-opus-4-8': 'anthropic',
  'gpt-5.4-2026-03-05': 'openai',
  'gpt-5.4': 'openai',
  'gpt-5.5': 'openai',
  'gemini-2.5-flash': 'gemini',
};

function providerFor(model) {
  const p = MODEL_ROUTING[model];
  if (p) return p;
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gpt/i.test(model)) return 'openai';
  if (/^gemini/i.test(model)) return 'gemini';
  throw new Error(`Unknown model id "${model}" — add it to MODEL_ROUTING in agentCall.js`);
}

/**
 * Render attachments as labelled blocks appended under the prompt. Keeps the
 * fixed prompt clean and makes it obvious in the logs what the model actually saw.
 */
function renderAttachments(attachments) {
  if (!attachments || typeof attachments !== 'object') return '';
  const parts = [];
  for (const [label, value] of Object.entries(attachments)) {
    if (value === undefined || value === null || value === '') continue;
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    parts.push(`<${label}>\n${body}\n</${label}>`);
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

async function callAnthropic({ model, system, userText, images }) {
  const content = [];
  images.forEach((img) => {
    if (img.caption) content.push({ type: 'text', text: img.caption });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  });
  content.push({ type: 'text', text: userText });

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content }],
    // NO temperature — Opus rejects it.
  };
  if (system) body.system = system;

  const res = await axios.post('https://api.anthropic.com/v1/messages', body, {
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  });

  const text = (res.data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    text,
    stopReason: res.data?.stop_reason || null,
    usage: res.data?.usage || null,
  };
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

async function callOpenAI({ model, system, userText, images }) {
  const content = [];
  images.forEach((img) => {
    if (img.caption) content.push({ type: 'text', text: img.caption });
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    });
  });
  content.push({ type: 'text', text: userText });

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages,
      max_completion_tokens: MAX_TOKENS, // NOT max_tokens on 5.x
      // NO temperature — newer models reject a custom value.
    },
    {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  const choice = res.data?.choices?.[0];
  return {
    text: (choice?.message?.content || '').trim(),
    stopReason: choice?.finish_reason || null,
    usage: res.data?.usage || null,
  };
}

// ─── Gemini ────────────────────────────────────────────────────────────────
// axios REST only. Never the @google/generative-ai SDK.

async function callGemini({ model, system, userText, images }) {
  const parts = [];
  images.forEach((img) => {
    if (img.caption) parts.push({ text: img.caption });
    parts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
  });
  parts.push({ text: userText });

  const body = {
    contents: [{ parts }],
    generationConfig: { maxOutputTokens: Math.min(MAX_TOKENS * 4, 65536), temperature: 0.4 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    body,
    { timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
  );

  const cand = res.data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return {
    text,
    stopReason: cand?.finishReason || null,
    usage: res.data?.usageMetadata || null,
  };
}

// ─── Public ────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.prompt       the fixed prompt (the user turn)
 * @param {string}   [opts.system]     system instruction
 * @param {string}   opts.model        API id — must be live-verified
 * @param {Array}    [opts.images]     [{ base64, mediaType, caption }]
 * @param {object}   [opts.attachments] labelled blocks appended under the prompt
 * @returns {{ text, stopReason, usage, model, provider, durationMs }}
 */
async function agentCall({ prompt, system, model, images = [], attachments = null }) {
  if (!prompt) throw new Error('agentCall: prompt is required');
  if (!model) throw new Error('agentCall: model is required');

  const provider = providerFor(model);
  const keyVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[provider];
  if (!process.env[keyVar]) {
    throw new Error(`agentCall: ${keyVar} is not set in ecosystem.config.js (pm2 delete + start after adding it)`);
  }

  const userText = `${prompt}${renderAttachments(attachments)}`;
  const started = Date.now();

  console.log(
    `[agentCall] ${provider}/${model} · ${images.length} image(s) · ` +
    `${Math.round(userText.length / 4)} approx prompt tokens · cap ${MAX_TOKENS}`
  );

  let out;
  try {
    if (provider === 'anthropic') out = await callAnthropic({ model, system, userText, images });
    else if (provider === 'openai') out = await callOpenAI({ model, system, userText, images });
    else out = await callGemini({ model, system, userText, images });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 600) : err.message;
    throw new Error(`${provider}/${model} call failed: ${detail}`);
  }

  const durationMs = Date.now() - started;
  console.log(`[agentCall] usage: ${JSON.stringify(out.usage)} · stop=${out.stopReason} · ${durationMs}ms`);

  // Empty content with a length stop is the reasoning-token starvation
  // signature — say so plainly instead of failing later at JSON.parse.
  if (!out.text) {
    throw new Error(
      out.stopReason === 'length' || out.stopReason === 'max_tokens' || out.stopReason === 'MAX_TOKENS'
        ? `${model} returned EMPTY content with stop reason "${out.stopReason}" — raise SKU_ANALYSER_MAX_TOKENS`
        : `${model} returned empty content (stop reason "${out.stopReason}")`
    );
  }

  return { ...out, model, provider, durationMs };
}

module.exports = { agentCall, MODEL_ROUTING, providerFor };
