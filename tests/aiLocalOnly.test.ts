/**
 * RT-AUDIT-P1-014 · Produkt-AI nur lokal (Betreiber-Vorgabe 2026-10-07)
 * =====================================================================
 * Begründung: docs/audit/AUDIT_2026-10-07_AI_LOKAL.md
 *
 * Garantien, die diese Datei festschreibt:
 *  1. Ohne Positivliste verlässt kein LLM-Aufruf das eigene System.
 *  2. Einziger zulässiger externer Weg: DeepSeek V4 (deepseek-pro/-flash) per
 *     AI_EXTERNAL_LLM_ALLOWLIST; unbekannte IDs werden ignoriert.
 *  3. „Zweites Augenpaar“: lokales Brain + DeepSeek Pro getrennt, DeepSeek nur
 *     wenn freigeschaltet.
 *  4. Sprachbefehl-NLU läuft über den LlmRouter (lokal), nicht über Cerebras.
 *  5. Statischer Wächter: keine Cloud-AI-Hosts mehr im Produktcode (src/, server/).
 *  6. CSP connect-src enthält keine AI-Provider-Hosts mehr.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  LlmRouter,
  externalLlmAllowlist,
  type ILlmProvider,
  type LlmProviderId,
  type LlmRequest,
} from '../src/core/ai/LlmRouter';
import { buildNluPrompt, parseNluIntent } from '../src/core/voice/VoiceControlService';
import { buildConnectSources } from '../server/csp';

const ROOT = path.resolve(__dirname, '..');

function stub(id: LlmProviderId, text = `${id} ok`): ILlmProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    available: true,
    complete: vi.fn(async (_req: LlmRequest) => ({ provider: id, text, latencyMs: 1 })),
  };
}

function routerWithStubs(): { router: LlmRouter; stubs: Record<LlmProviderId, ReturnType<typeof stub>> } {
  const router = new LlmRouter();
  const stubs = {
    'runpod-local': stub('runpod-local'),
    'deepseek-flash': stub('deepseek-flash'),
    'deepseek-pro': stub('deepseek-pro'),
  };
  for (const s of Object.values(stubs)) router.register(s);
  return { router, stubs };
}

afterEach(() => {
  delete process.env.AI_EXTERNAL_LLM_ALLOWLIST;
  delete process.env.AI_ALLOW_EXTERNAL_LLM;
  vi.unstubAllGlobals();
});

describe('RT-AUDIT-P1-014 · Positivliste', () => {
  it('Default: nur das lokale Brain, auch wenn DeepSeek verfügbar wäre', () => {
    const { router } = routerWithStubs();
    for (const c of ['simple', 'moderate', 'complex'] as const) {
      expect(router.rankProviders(c).map((p) => p.id)).toEqual(['runpod-local']);
    }
  });

  it('nur deepseek-pro freigeschaltet → genau lokal + Pro (simple kennt Pro nicht)', () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'deepseek-pro';
    const { router } = routerWithStubs();
    expect(router.rankProviders('complex').map((p) => p.id)).toEqual(['runpod-local', 'deepseek-pro']);
    expect(router.rankProviders('moderate').map((p) => p.id)).toEqual(['runpod-local', 'deepseek-pro']);
    expect(router.rankProviders('simple').map((p) => p.id)).toEqual(['runpod-local']);
  });

  it('unbekannte/entfernte Provider in der Liste werden ignoriert', () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'cerebras, openai ,mistral,openrouter,gemini,publicai';
    expect(externalLlmAllowlist().size).toBe(0);
    const { router } = routerWithStubs();
    expect(router.rankProviders('complex').map((p) => p.id)).toEqual(['runpod-local']);
  });

  it('Groß-/Kleinschreibung und Leerzeichen sind egal', () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = ' DeepSeek-Pro , deepseek-flash ';
    expect([...externalLlmAllowlist()].sort()).toEqual(['deepseek-flash', 'deepseek-pro']);
  });

  it('Legacy-Alias AI_ALLOW_EXTERNAL_LLM=true = beide DeepSeek-Wege, nichts sonst', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    expect([...externalLlmAllowlist()].sort()).toEqual(['deepseek-flash', 'deepseek-pro']);
    const { router } = routerWithStubs();
    expect(router.rankProviders('complex').map((p) => p.id)).toEqual(['runpod-local', 'deepseek-pro', 'deepseek-flash']);
  });

  it('der Router kennt nur noch runpod-local und die zwei DeepSeek-Wege', () => {
    expect(new LlmRouter().providerIds()).toEqual(['runpod-local', 'deepseek-flash', 'deepseek-pro']);
  });

  it('ohne Freigabe wird DeepSeek nie angefragt, auch wenn das Brain ausfällt', async () => {
    const { router, stubs } = routerWithStubs();
    stubs['runpod-local'].complete.mockRejectedValueOnce(new Error('brain down'));
    await expect(router.complete({ prompt: 'x', complexity: 'complex' })).rejects.toThrow('brain down');
    expect(stubs['deepseek-pro'].complete).not.toHaveBeenCalled();
    expect(stubs['deepseek-flash'].complete).not.toHaveBeenCalled();
  });

  it('mit Freigabe springt DeepSeek Pro als Notfall-Backup ein, wenn das Brain ausfällt', async () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'deepseek-pro';
    const { router, stubs } = routerWithStubs();
    stubs['runpod-local'].complete.mockRejectedValueOnce(new Error('brain down'));
    const completion = await router.complete({ prompt: 'x', complexity: 'complex' });
    expect(completion.provider).toBe('deepseek-pro');
  });
});

describe('RT-AUDIT-P1-014 · Zweites Augenpaar', () => {
  it('ohne Freigabe: nur lokale Antwort, second = null, DeepSeek nicht angefragt', async () => {
    const { router, stubs } = routerWithStubs();
    const result = await router.secondOpinion({ prompt: 'Prüfe den Mix', complexity: 'complex' });
    expect(result.primary).toMatchObject({ provider: 'runpod-local', text: 'runpod-local ok' });
    expect(result.second).toBeNull();
    expect(stubs['deepseek-pro'].complete).not.toHaveBeenCalled();
  });

  it('mit Freigabe: beide Antworten getrennt', async () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'deepseek-pro';
    const { router } = routerWithStubs();
    const result = await router.secondOpinion({ prompt: 'Prüfe den Mix', complexity: 'complex' });
    expect(result.primary).toMatchObject({ provider: 'runpod-local' });
    expect(result.second).toMatchObject({ provider: 'deepseek-pro', text: 'deepseek-pro ok' });
  });

  it('Fehler einer Seite werden gemeldet, die andere Antwort bleibt erhalten', async () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'deepseek-pro';
    const { router, stubs } = routerWithStubs();
    stubs['runpod-local'].complete.mockRejectedValueOnce(new Error('brain down'));
    const result = await router.secondOpinion({ prompt: 'x', complexity: 'complex' });
    expect(result.primary).toEqual({ error: 'brain down' });
    expect(result.second).toMatchObject({ provider: 'deepseek-pro' });
  });

  it('nur deepseek-flash freigeschaltet reicht NICHT für die Zweitmeinung (die nutzt Pro)', async () => {
    process.env.AI_EXTERNAL_LLM_ALLOWLIST = 'deepseek-flash';
    const { router } = routerWithStubs();
    const result = await router.secondOpinion({ prompt: 'x', complexity: 'complex' });
    expect(result.second).toBeNull();
  });
});

describe('RT-AUDIT-P1-014 · Sprachbefehl-NLU lokal', () => {
  it('Prompt verlangt reines JSON und enthält Plugin + Kommando', () => {
    const prompt = buildNluPrompt('mach den Bass lauter', 'mixer');
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"mixer"');
    expect(prompt).toContain('"mach den Bass lauter"');
  });

  it('parst JSON auch mit Text drumherum und normalisiert Parameter zu Strings', () => {
    expect(parseNluIntent('Klar: {"action":"setGain","parameters":{"channel":3,"db":-2}} fertig'))
      .toEqual({ action: 'setGain', parameters: { channel: '3', db: '-2' } });
  });

  it('liefert null bei fehlender action, ungültigem JSON oder ohne Objekt', () => {
    expect(parseNluIntent('{"parameters":{}}')).toBeNull();
    expect(parseNluIntent('{action: kaputt}')).toBeNull();
    expect(parseNluIntent('keine Ahnung')).toBeNull();
  });

  it('VoiceControlService nutzt keinen ProviderRouter/Cerebras mehr', () => {
    // Kommentare entfernen: geprüft wird nur ausführbarer Code.
    const src = readFileSync(path.join(ROOT, 'src/core/voice/VoiceControlService.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/cerebras/i);
    expect(src).not.toMatch(/ProviderRouter/);
    expect(src).not.toMatch(/gpt-oss-120b/);
    expect(src).toMatch(/completeLlm/);
  });
});

describe('RT-AUDIT-P1-014 · statischer Wächter gegen Cloud-AI im Produktcode', () => {
  /** Hosts der entfernten Cloud-AI-Anbieter. DeepSeek ist bewusst NICHT dabei (zulässige Ausnahme). */
  const FORBIDDEN_HOSTS = [
    'api.cerebras.ai',
    'openrouter.ai',
    'api.mistral.ai',
    'api.publicai.co',
    'generativelanguage.googleapis.com',
    'api.openai.com',
    'api.replicate.com',
    'router.huggingface.co',
    'api-inference.huggingface.co',
    'endpoints.huggingface.cloud',
    'api.groq.com',
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('kein entfernter Cloud-AI-Host in src/, server/ oder server.ts', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'server')), path.join(ROOT, 'server.ts')];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const host of FORBIDDEN_HOSTS) {
        if (text.includes(host)) hits.push(`${path.relative(ROOT, file)} → ${host}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('der Cerebras-Provider des Orchestrators ist gelöscht', () => {
    expect(existsSync(path.join(ROOT, 'src/core/ai/orchestrator/cerebrasProvider.ts'))).toBe(false);
    const router = readFileSync(path.join(ROOT, 'src/core/ai/orchestrator/providerRouter.ts'), 'utf8');
    expect(router).not.toMatch(/CerebrasProvider/);
  });

  it('CSP connect-src enthält keine AI-Provider-Hosts mehr', () => {
    const sources = buildConnectSources({});
    for (const host of [...FORBIDDEN_HOSTS, 'api.deepseek.com']) {
      expect(sources.some((s) => s.includes(host))).toBe(false);
    }
  });
});
