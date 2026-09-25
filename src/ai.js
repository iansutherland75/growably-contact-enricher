/**
 * AI provider for the pre-meeting brief. Anthropic (Claude) or OpenAI,
 * chosen during setup. Only the brief calls this; enrichment never uses an
 * AI model, so an install without an AI key still enriches contacts.
 *
 * Both providers are called with plain fetch so the worker keeps a single
 * dependency (hono). Model IDs can be overridden per install (AI_MODEL).
 */

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    defaultModel: 'gpt-6-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

// Transient statuses worth a second try. Anthropic returns 529 when
// overloaded; both providers use 429 for rate limits.
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 529]);

export function aiConfigured(env) {
  return Boolean(env.AI_API_KEY) && Boolean(PROVIDERS[env.AI_PROVIDER]);
}

export function modelFor(env) {
  return env.AI_MODEL || PROVIDERS[env.AI_PROVIDER]?.defaultModel || '';
}

/**
 * POST with a bounded retry. The brief has to finish inside the browser's
 * 100 s edge timeout, so this retries at most twice, only on transient
 * failures, and only while a retry can still fit.
 */
async function postJson(url, headers, body, label, { attempts = 3, retryBudgetMs = 30000 } = {}) {
  const start = Date.now();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      if (Date.now() - start > retryBudgetMs) break;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      lastErr = new Error(`${label}: network error: ${e.message}`);
      console.warn(`[ai] attempt ${i + 1} failed: ${lastErr.message}`);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    lastErr = new Error(describeFailure(label, res.status, text));
    console.warn(`[ai] attempt ${i + 1} failed: ${lastErr.message}`);
    // A 429 for "no credits" is not transient; retrying only burns time.
    if (!RETRY_STATUSES.has(res.status) || /insufficient_quota|credit balance|billing/i.test(text)) throw lastErr;
  }
  throw lastErr;
}

function describeFailure(label, status, text) {
  const snippet = text.slice(0, 200);
  if (status === 401 || status === 403) return `${label}: ${status}. The API key was rejected. Check it in Settings.`;
  if (status === 404 && /model/i.test(text)) return `${label}: 404. The model was not found. Check the model name in Settings.`;
  if (/insufficient_quota|credit balance|billing/i.test(text)) return `${label}: the account has no credits. Add credits in the provider's billing settings, then try again.`;
  return `${label}: ${status}: ${snippet}`;
}

/**
 * Generate text from a system prompt and one user message.
 * Returns { text, model, provider, stopReason, usage: { input, output } }.
 * Throws with a readable message on failure or refusal.
 */
export async function generateText({ system, user, maxTokens = 8000, effort = 'medium' }, env) {
  const provider = env.AI_PROVIDER;
  if (!PROVIDERS[provider]) throw new Error(`Unknown AI provider "${provider}". Use "anthropic" or "openai".`);
  if (!env.AI_API_KEY) throw new Error('No AI API key set. Add one in Settings.');
  const model = modelFor(env);
  return provider === 'openai'
    ? openaiGenerate({ system, user, maxTokens, model }, env)
    : anthropicGenerate({ system, user, maxTokens, effort, model }, env);
}

async function anthropicGenerate({ system, user, maxTokens, effort, model }, env) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  // Effort is accepted on Claude Opus 4.5+ and Sonnet 4.6+. Older or smaller
  // models reject it, so leave it out for those.
  if (!/haiku|-4-5|-3-/.test(model)) body.output_config = { effort };

  const data = await postJson('https://api.anthropic.com/v1/messages', {
    'x-api-key': env.AI_API_KEY,
    'anthropic-version': '2023-06-01',
  }, body, 'Claude API');

  if (data.stop_reason === 'refusal') {
    throw new Error(`Claude declined to write this (${data.stop_details?.category ?? 'no category given'})`);
  }
  // The text block is not always content[0]: thinking blocks come first.
  const text = data.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error(`Claude returned no text (stop_reason: ${data.stop_reason})`);
  return {
    text, model: data.model, provider: 'anthropic', stopReason: data.stop_reason,
    usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
  };
}

async function openaiGenerate({ system, user, maxTokens, model }, env) {
  const data = await postJson('https://api.openai.com/v1/responses', {
    Authorization: `Bearer ${env.AI_API_KEY}`,
  }, {
    model,
    instructions: system,
    input: user,
    max_output_tokens: maxTokens,
  }, 'OpenAI API');

  const message = (data.output ?? []).find(o => o.type === 'message');
  const refusal = message?.content?.find(c => c.type === 'refusal');
  if (refusal) throw new Error(`OpenAI declined to write this: ${refusal.refusal}`);
  const text = (message?.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
  if (!text) {
    const why = data.incomplete_details?.reason ? `, ${data.incomplete_details.reason}` : '';
    throw new Error(`OpenAI returned no text (status: ${data.status}${why})`);
  }
  return {
    text, model: data.model, provider: 'openai', stopReason: data.status,
    usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
  };
}

/**
 * Cheapest possible round trip to confirm a key and model work. Used by the
 * Test buttons in setup and Settings. Returns { ok, model } or { ok: false, error }.
 */
export async function testProvider(env) {
  try {
    const r = await generateText({
      system: 'Reply with the single word OK and nothing else.',
      user: 'Ready?',
      maxTokens: 200,
      effort: 'low',
    }, env);
    return { ok: true, model: r.model };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
