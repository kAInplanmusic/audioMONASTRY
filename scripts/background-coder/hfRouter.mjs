#!/usr/bin/env node
/**
 * HFRouterProvider – offizieller Hugging-Face-Router-Layer für den Background-Coder.
 *
 * - Nutzt ausschließlich https://router.huggingface.co/v1/chat/completions
 * - KEIN Dedicated Endpoint, KEINE HF_ENDPOINT_URL
 * - Auth: HF_TOKEN (Fallback HF_API_KEY, falls bereits im Projekt genutzt)
 * - Abrechnung: HF-Konto/PRO-Credits; kein separater Provider-Key
 * - Quota/Billing/429 → sauber PAUSED/BLOCKED mit strukturiertem Fehler
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const HF_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';

const BUDGET = {
  maxRetries: 3,
  backoffBaseMs: 1000,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 120_000,
  taskTimeoutMs: 600_000,
  maxParallel: 2,
  sessionRequestLimit: 250,
  dailyRequestLimit: 1500,
  quotaPauseMs: 600_000,
};

const BUDGET_SCHEMA = {
  maxRetries: { type: 'number', min: 0, max: 10 },
  backoffBaseMs: { type: 'number', min: 100, max: 60_000 },
  maxBackoffMs: { type: 'number', min: 1_000, max: 300_000 },
  requestTimeoutMs: { type: 'number', min: 5_000, max: 600_000 },
  taskTimeoutMs: { type: 'number', min: 10_000, max: 3_600_000 },
  maxParallel: { type: 'number', min: 1, max: 16 },
  sessionRequestLimit: { type: 'number', min: 1, max: 10_000 },
  dailyRequestLimit: { type: 'number', min: 1, max: 100_000 },
  quotaPauseMs: { type: 'number', min: 0, max: 3_600_000 },
};

function mergeBudget(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(source)) {
    const rule = BUDGET_SCHEMA[key];
    if (!rule) continue; // unbekannte Keys werden ignoriert
    const value = source[key];
    if (typeof value !== rule.type || Number.isNaN(value)) {
      throw new Error(`Ungültiger Wert für budget.${key}: ${value}`);
    }
    if (value < rule.min || value > rule.max) {
      throw new Error(`budget.${key} außerhalb erlaubtem Bereich (${rule.min}-${rule.max}): ${value}`);
    }
    target[key] = value;
  }
}

class QuotaPausedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaPausedError';
    this.code = 'QUOTA_PAUSED';
  }
}

class HFRouterProvider {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.requestCount = { session: 0, day: 0 };
    this.paused = false;
    this.pausedReason = null;
    this.quotaStopAt = null;
    const configPath = path.join(__dirname, 'config.json');
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg?.budget) mergeBudget(BUDGET, cfg.budget);
    } catch (e) {
      if (e instanceof SyntaxError || e?.code === 'ENOENT') {
        // Defaults oder ungültiges JSON → Defaults verwenden
      } else {
        throw e; // Validierungsfehler bewusst hochwerfen
      }
    }
  }

  apiKey() {
    const token = process.env.HF_TOKEN?.trim() || process.env.HF_API_KEY?.trim();
    if (!token) return null;
    return token;
  }

  isPaused() {
    if (this.paused && this.quotaStopAt && Date.now() > this.quotaStopAt) {
      this.paused = false;
      this.pausedReason = null;
      this.quotaStopAt = null;
    }
    return this.paused;
  }

  pause(reason) {
    this.paused = true;
    this.pausedReason = reason;
    this.quotaStopAt = Date.now() + (BUDGET.quotaPauseMs ?? 600_000);
  }

  recordRequest() {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (this.dayKey !== dayKey) {
      this.dayKey = dayKey;
      this.requestCount.day = 0;
    }
    this.requestCount.session += 1;
    this.requestCount.day += 1;
    if (this.requestCount.day > BUDGET.dailyRequestLimit || this.requestCount.session > BUDGET.sessionRequestLimit) {
      throw new QuotaPausedError(`Tages-/Session-Limit erreicht (${this.requestCount.day}/${BUDGET.dailyRequestLimit})`);
    }
  }

  classifyError(status, text, e) {
    const lower = `${text || ''} ${e?.message || ''}`.toLowerCase();
    if (status === 401 || status === 403) return { type: 'AUTH_ERROR', message: 'HF-Token ungültig oder ohne Berechtigung', fatal: true };
    if (status === 402 || /billing|payment|credits?|quota|purchase|insufficient/i.test(lower)) {
      return { type: 'BILLING_QUOTA', message: 'HF-Credits/Quota erschöpft – Background-Coder pausiert', fatal: true };
    }
    if (status === 429 || /rate\s*limit|too many/i.test(lower)) return { type: 'RATE_LIMIT', message: 'Rate Limit', fatal: false };
    if (status >= 500) return { type: 'SERVER_ERROR', message: `HF Router ${status}`, fatal: false };
    return { type: 'HTTP_ERROR', message: `HTTP ${status}: ${text?.slice(0, 200) || e?.message || ''}`, fatal: false };
  }

  async chat({ modelId, messages, maxTokens, temperature }) {
    if (this.isPaused()) {
      throw new QuotaPausedError(this.pausedReason ?? 'Pipeline pausiert (Quota/Billing)');
    }
    const key = this.apiKey();
    if (!key) {
      throw new Error('Kein HF_TOKEN/HF_API_KEY gefunden – keine Inference möglich.');
    }
    this.recordRequest();

    let lastErr = null;
    for (let attempt = 0; attempt <= BUDGET.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BUDGET.requestTimeoutMs);
      try {
        const res = await fetch(HF_ROUTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          signal: controller.signal,
          body: JSON.stringify({
            model: modelId,
            messages,
            temperature: temperature ?? 0.2,
            max_tokens: maxTokens ?? 8192,
            // Provider auto = HF wählt den besten verfügbaren Inference Provider.
            provider: { provider: 'auto' },
          }),
        });
        const text = await res.text();
        if (!res.ok) {
          const cls = this.classifyError(res.status, text, lastErr);
          if (cls.fatal || cls.type === 'BILLING_QUOTA' || cls.type === 'AUTH_ERROR') {
            if (cls.type === 'BILLING_QUOTA') this.pause(cls.message);
            throw new QuotaPausedError(cls.message);
          }
          lastErr = new Error(cls.message);
          this.log(`[hf-router] ${modelId}: ${cls.message} (Attempt ${attempt + 1})`);
          if (attempt < BUDGET.maxRetries) {
            const wait = Math.min(BUDGET.maxBackoffMs, BUDGET.backoffBaseMs * 2 ** attempt);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw lastErr;
        }
        const data = JSON.parse(text);
        const content = data.choices?.[0]?.message?.content ?? '';
        this.log(`[hf-router] ${modelId}: ok (${content.length} chars)`);
        return { content, modelId, provider: data.model ?? 'auto' };
      } catch (e) {
        if (e instanceof QuotaPausedError) throw e;
        if (e?.name === 'AbortError') {
          lastErr = new Error('Request-Timeout');
          if (attempt < BUDGET.maxRetries) {
            const wait = Math.min(BUDGET.maxBackoffMs, BUDGET.backoffBaseMs * 2 ** attempt);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw lastErr;
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastErr ?? new Error('Unbekannter HF-Router-Fehler');
  }
}

export const hfRouter = new HFRouterProvider();
export { QuotaPausedError };
