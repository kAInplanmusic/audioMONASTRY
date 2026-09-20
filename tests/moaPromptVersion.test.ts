// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MoaAgent } from '../src/core/ai/MoaAgent';
import { MOA_GLOBAL_PROMPT_KEY, PromptStore } from '../src/core/ai/orchestrator/promptStore';
import { PLUGIN_MOA_SYSTEM_PROMPTS } from '../src/utils/prompts';
import type { LlmCompletion, LlmRequest } from '../src/core/ai/LlmRouter';

/**
 * INFRA-AI-003: Der Prompt-Store war wirkungslos – kein Produktionspfad las ihn,
 * eine „optimierte" Version (`npm run iterate:prompts`) blieb ein DB-Eintrag und
 * erreichte nie einen echten LLM-Aufruf. Diese Tests halten fest, dass
 * (a) `hydrate()` den Store aus der Persistenz fuellt und
 * (b) die aktive Version im PROMPT ankommt, den der Plan-Aufruf rausschickt.
 */
function capturingAgent(prompts: PromptStore): { agent: MoaAgent; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const complete = async (req: LlmRequest): Promise<LlmCompletion> => {
    seen.push(req);
    return { provider: 'ollama', text: '[]', latencyMs: 1 };
  };
  // Signatur: complete, voice, estimateCost, planTimeoutMs, planCatalog, prompts
  const agent = new MoaAgent(
    complete,
    undefined as never,
    () => 0,
    1000,
    undefined,
    prompts,
  );
  return { agent, seen };
}

describe('INFRA-AI-003 · Prompt-Versionierung wirkt auf den Plan-Aufruf', () => {
  it('hydratisiert Versionen und aktiviert die hoechste', () => {
    const store = new PromptStore();
    const loaded = store.hydrate([
      { pluginId: 'mixer', content: 'v1 Mixer', version: 1 },
      { pluginId: 'mixer', content: 'v2 Mixer mit Kommandos', version: 2 },
      { pluginId: 'eq', content: 'EQ v1', version: 1, enabled: false },
      { pluginId: '', content: 'leer', version: 1 },
      { pluginId: 'drop', content: '   ', version: 1 },
    ]);

    expect(loaded).toBe(3); // leere Zeilen werden uebersprungen
    expect(store.getActive('mixer')?.version).toBe(2);
    expect(store.getActive('mixer')?.content).toBe('v2 Mixer mit Kommandos');
    // `enabled: false` aktiviert nichts.
    expect(store.getActive('eq')).toBeNull();
    // Nachvollziehbar versioniert: beide Mixer-Versionen liegen im Store.
    expect(store.listVersions('mixer').map((p) => p.version)).toEqual([2, 1]);
  });

  it('schickt die aktivierte Version im erzeugten LLM-Prompt mit', async () => {
    const store = new PromptStore();
    store.upsert('mixer', 'ROLLE-AUS-DEM-STORE: nutze gain(db), fade_in_main(channel)', { version: 7 });
    const { agent, seen } = capturingAgent(store);

    await agent.plan('Setze einen ausgewogenen Mix', 'mixer');

    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain('ROLLE-AUS-DEM-STORE');
    // Die Konstante ist damit verdraengt.
    expect(seen[0].prompt).not.toContain(PLUGIN_MOA_SYSTEM_PROMPTS.mixer);
  });

  it('faellt ohne Store-Eintrag auf die Konstante zurueck', async () => {
    const store = new PromptStore();
    const { agent, seen } = capturingAgent(store);

    await agent.plan('Setze einen ausgewogenen Mix', 'mixer');

    expect(seen[0].prompt).toContain(PLUGIN_MOA_SYSTEM_PROMPTS.mixer);
  });

  it('nutzt den globalen Planer-Prompt, wenn kein Plugin-Kontext vorliegt', async () => {
    const store = new PromptStore();
    store.upsert(MOA_GLOBAL_PROMPT_KEY, 'GLOBALER-PLANER-PROMPT');
    const { agent, seen } = capturingAgent(store);

    await agent.plan('Raeume die Session auf');

    expect(seen[0].prompt).toContain('GLOBALER-PLANER-PROMPT');
  });
});
