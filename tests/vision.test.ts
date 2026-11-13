import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISION_STYLES, VISION_STYLE_SUFFIX, buildVisionPrompt, suggestVisionStyle } from '../src/core/ai/vision/visionPrompt';
import { fluxVisionWorkflow, generateVideo, generateVisionImage } from '../src/core/ai/vision/vastVisual';
import { extractVideo, extractVisionImage, stripDataUri } from '../src/core/ai/vision/visualOutput';
import { AiProviderError } from '../src/core/ai/orchestrator/types';
import { AiVisionFeedbackSchema, AiVisionSchema } from '../shared/schemas.ts';
import { aggregateFeedback, normalizeRating, normalizeTags, topStyles } from '../src/core/ai/vision/visualFeedback';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';

/**
 * Die Visual-Aufrufe laufen über den ProviderRouter (Rolle imageHq/videoReal,
 * Vast-Pod). Hier wird nur der Vertrag zum Router geprüft – Pod-Transport,
 * Polling und Breaker deckt vastProvider.test.ts ab.
 */
const routerRun = vi.hoisted(() => vi.fn());
vi.mock('../src/core/ai/orchestrator/providerRouter', () => ({
  ProviderRouter: class {
    run = routerRun;
  },
}));
// Die echte Flotte hat (noch) keinen Visual-Pod – dieser Fall steht in
// visualGate.test.ts. Hier wird ein Pod angenommen, um den Vertrag zu prüfen.
vi.mock('../src/core/ai/orchestrator/podRouting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/ai/orchestrator/podRouting')>()),
  podRoleFor: () => 'vis',
}));

const DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/**
 * INFRA-FEAT-001/002: Die Visual-Pfade hängen am AI-Betriebsmodus. Diese Datei
 * prüft den Worker-Vertrag (Requests, Antworten, Fehlercodes) – die Sperre
 * selbst deckt `visualGate.test.ts` ab. Deshalb steht der Modus hier auf
 * „AI an mit Visuals“, sonst würde jeder Aufruf schon an der Gate scheitern.
 */
beforeEach(() => {
  __resetAiGate();
  setAiOperatingMode('on-with-visuals', { source: 'test' });
  routerRun.mockReset();
});

afterEach(() => {
  __resetAiGate();
});

describe('VisualMONK – Vision-Prompt', () => {
  it('baut aus Text + Stil einen Prompt', () => {
    const p = buildVisionPrompt({ text: 'ein einsamer Leuchtturm im Sturm', style: 'noir' });
    expect(p).toContain('ein einsamer Leuchtturm im Sturm');
    expect(p).toContain('film noir');
  });

  it('nimmt Tempo, Energie und Mood-Tags auf', () => {
    const fast = buildVisionPrompt({ text: 'x', bpm: 174, energy: 0.9 });
    expect(fast).toContain('174 bpm');
    expect(fast).toContain('explosive');
    const slow = buildVisionPrompt({ text: 'y', bpm: 90, energy: 0.1 });
    expect(slow).toContain('slow tempo 90 bpm');
    expect(slow).toContain('calm ambient');
    const tags = buildVisionPrompt({ prompt: 'z', moodTags: ['techno', 'dark', ''] } as never);
    expect(tags).toContain('techno');
    expect(tags).toContain('dark');
  });

  it('fällt ohne Eingaben auf einen Ambient-Prompt zurück und begrenzt die Länge', () => {
    expect(buildVisionPrompt({})).toContain('abstract ambient visual');
    const long = buildVisionPrompt({ text: 'a'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(1200);
    expect(buildVisionPrompt({ text: ' same ', bpm: 128 })).toBe(buildVisionPrompt({ text: ' same ', bpm: 128 }));
  });

  it('hat für jeden Stil einen Zusatz', () => {
    for (const s of VISION_STYLES) expect(VISION_STYLE_SUFFIX[s]).toBeTruthy();
  });

  it('haelt Zod-Enum und Style-Liste deckungsgleich', () => {
    const schemaStyles = AiVisionSchema.shape.style.unwrap().options;
    expect([...schemaStyles].sort()).toEqual([...VISION_STYLES].sort());
  });
});

describe('VisualMONK – Vision-Client', () => {
  it('extrahiert data-URI, Array und URL', () => {
    expect(extractVisionImage({ image_url: DATA_URI })).toBe(DATA_URI);
    expect(extractVisionImage({ images: [DATA_URI] })).toBe(DATA_URI);
    expect(extractVisionImage({ output: { nested: { url: 'https://x/y.png' } } })).toBe('https://x/y.png');
    expect(extractVisionImage({ seed: 1 })).toBeNull();
    expect(extractVisionImage(null)).toBeNull();
  });

  it('liefert das Bild aus der Worker-Ausgabe der imageHq-Rolle', async () => {
    routerRun.mockResolvedValue({ provider: 'vast-imageHq', result: { image_url: DATA_URI, seed: 42 } });
    const res = await generateVisionImage('test');
    expect(res.image).toBe(DATA_URI);
    expect(res.seed).toBe(42);
    expect(res.prompt).toBe('test');
    expect(routerRun).toHaveBeenCalledTimes(1);
    const [task, model, input] = routerRun.mock.calls[0];
    expect(task).toBe('image.generate');
    expect(model).toBe('flux-dev');
    // worker-comfyui-Vertrag: der Prompt steckt im mitgeschickten Graphen.
    const wf = (input as { workflow: Record<string, { inputs: Record<string, unknown> }> }).workflow;
    expect(wf['2'].inputs.text).toBe('test');
  });

  it('liest die Live-Form des Pod-Adapters (kind/items/data)', async () => {
    routerRun.mockResolvedValue({ provider: 'vast-imageHq', result: { kind: 'image', count: 1, items: [{ kind: 'image', data: DATA_URI }] } });
    const res = await generateVisionImage('p');
    expect(res.image).toBe(DATA_URI);
  });

  it('wirft typisierte Fehler: ohne Prompt, ohne Bild, und reicht Provider-Fehler durch', async () => {
    await expect(generateVisionImage('   ')).rejects.toMatchObject({ code: 'NO_PROMPT' });
    expect(routerRun).not.toHaveBeenCalled();
    routerRun.mockResolvedValueOnce({ provider: 'vast-imageHq', result: { seed: 1 } });
    const noImage = generateVisionImage('p');
    await expect(noImage).rejects.toBeInstanceOf(AiProviderError);
    await expect(noImage).rejects.toMatchObject({ code: 'NO_IMAGE' });
    routerRun.mockRejectedValueOnce(new AiProviderError('vast-imageHq', 'NO_POD_FOR_ROLE', 'kein Pod', false));
    await expect(generateVisionImage('p')).rejects.toMatchObject({ code: 'NO_POD_FOR_ROLE' });
  });
});

describe('VisualMONK – Stil aus dem Set (AUTO-Modus)', () => {
  it('wählt den Stil aus Energie und Tempo', () => {
    expect(suggestVisionStyle({ energy: 0.9, bpm: 150 })).toBe('industrial');
    expect(suggestVisionStyle({ energy: 0.8, bpm: 100 })).toBe('fire');
    expect(suggestVisionStyle({ energy: 0.5, bpm: 128 })).toBe('psychedelic');
    expect(suggestVisionStyle({ energy: 0.5, bpm: 90 })).toBe('cosmic');
    expect(suggestVisionStyle({ energy: 0.3, bpm: 130 })).toBe('geometry');
    expect(suggestVisionStyle({ energy: 0.3, bpm: 90 })).toBe('liquid');
    expect(suggestVisionStyle({ energy: 0.1 })).toBe('abstract');
    // Default-Energie 0.4, kein Tempo -> liquid
    expect(suggestVisionStyle({})).toBe('liquid');
  });

  it('ist deterministisch und liegt innerhalb der Stil-Liste', () => {
    for (const energy of [0, 0.2, 0.5, 0.9]) {
      const a = suggestVisionStyle({ energy, bpm: 128 });
      const b = suggestVisionStyle({ energy, bpm: 128 });
      expect(a).toBe(b);
      expect(VISION_STYLES).toContain(a);
    }
  });
});


describe('VisualMONK – Selbstlern-Loop (Feedback)', () => {
  it('normalisiert Bewertungen auf 1..5', () => {
    expect(normalizeRating(4.4)).toBe(4);
    expect(normalizeRating('5')).toBe(5);
    expect(normalizeRating(0)).toBeNull();
    expect(normalizeRating(6)).toBeNull();
    expect(normalizeRating('x')).toBeNull();
    expect(normalizeRating(Number.NaN)).toBeNull();
  });

  it('bereinigt Tags', () => {
    expect(normalizeTags([' techno ', 'dark', 'techno', '', 3])).toEqual(['techno', 'dark', '3']);
    expect(normalizeTags('nope')).toEqual([]);
  });

  it('aggregiert Feedback', () => {
    expect(aggregateFeedback([])).toEqual({ count: 0, avgRating: 0, keepRatio: 0 });
    const agg = aggregateFeedback([
      { generationId: 'a', rating: 5, keep: true },
      { generationId: 'b', rating: 3, keep: true },
      { generationId: 'c', rating: 1, keep: false },
    ]);
    expect(agg.count).toBe(3);
    expect(agg.avgRating).toBe(3);
    expect(agg.keepRatio).toBe(0.67);
  });

  it('waehlt die besten Stile mit Mindest-Feedback', () => {
    const rows = [
      { style: 'cosmic', avgRating: 4.8, feedbackCount: 5 },
      { style: 'noir', avgRating: 4.9, feedbackCount: 1 },
      { style: 'fire', avgRating: 4.2, feedbackCount: 3 },
      { style: null, avgRating: 5, feedbackCount: 9 },
    ];
    expect(topStyles(rows, { minFeedback: 2, limit: 2 })).toEqual(['cosmic', 'fire']);
  });

  it('haelt das Feedback-Schema deckungsgleich', () => {
    expect(AiVisionFeedbackSchema.safeParse({ generationId: 'g1', rating: 4 }).success).toBe(true);
    expect(AiVisionFeedbackSchema.safeParse({ generationId: 'g1', rating: 9 }).success).toBe(false);
    expect(AiVisionFeedbackSchema.safeParse({ rating: 4 }).success).toBe(false);
  });
});

describe('VisualMONK – Video-Client (Wan2.2 image->video)', () => {
  it('entfernt das data-URI-Praefix und Whitespace', () => {
    expect(stripDataUri('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(stripDataUri('AAAA')).toBe('AAAA');
    expect(stripDataUri('data:image/png;base64,AA\nBB')).toBe('AABB');
  });

  it('extrahiert rohes base64, data-URI und URLs', () => {
    const raw = 'A'.repeat(200);
    expect(extractVideo({ video: raw })).toBe(raw);
    expect(extractVideo({ output: { video: 'data:video/mp4;base64,AAAA' } })).toBe('data:video/mp4;base64,AAAA');
    expect(extractVideo({ videos: ['https://x/y.mp4'] })).toBe('https://x/y.mp4');
    expect(extractVideo({ seed: 1 })).toBeNull();
  });

  it('erzeugt aus einem Bild einen Clip (Wan-Vertrag: image_base64 ohne data:-Praefix)', async () => {
    const raw = 'B'.repeat(150);
    routerRun.mockResolvedValue({ provider: 'vast-videoReal', result: { video: raw } });
    const res = await generateVideo('data:image/png;base64,AAAA', 'push in', { seed: 3, negativePrompt: 'blur' });
    expect(res.video).toBe(`data:video/mp4;base64,${raw}`);
    const [task, model, input] = routerRun.mock.calls[0];
    expect(task).toBe('video.generate');
    expect(model).toBe('wan2.2');
    expect(input).toMatchObject({ image_base64: 'AAAA', prompt: 'push in', steps: 6, width: 480, height: 832, cfg: 2.0, seed: 3, negative_prompt: 'blur' });
    expect(input).not.toHaveProperty('image');
  });

  it('wirft typisierte Fehler', async () => {
    await expect(generateVideo('', 'p')).rejects.toMatchObject({ code: 'NO_IMAGE' });
    expect(routerRun).not.toHaveBeenCalled();
    routerRun.mockResolvedValueOnce({ provider: 'vast-videoReal', result: { seed: 1 } });
    await expect(generateVideo('x', 'p')).rejects.toMatchObject({ code: 'NO_VIDEO' });
    routerRun.mockRejectedValueOnce(new AiProviderError('vast-videoReal', 'JOB_FAILED', 'boom', true));
    await expect(generateVideo('x', 'p')).rejects.toMatchObject({ code: 'JOB_FAILED' });
  });
});

/**
 * Weg A (2026-09-27): Die Bild-Rolle laeuft auf worker-comfyui.
 * Der kennt KEINEN prompt-Parameter — der Text muss im Graphen stehen, sonst
 * liefert jeder Aufruf das Demo-Bild des Workflows, waehrend der Aufrufer sein
 * Ergebnis fuer erledigt haelt. Diese Tests halten diesen Vertrag fest.
 */
describe('worker-comfyui-Vertrag (Bild-Rolle, Weg A)', () => {
  it('legt den Prompt in den Textknoten, nicht in ein prompt-Feld', () => {
    const wf = fluxVisionWorkflow({ prompt: 'neon alley', steps: 12, width: 768, height: 1344 }) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(wf['2'].inputs.text).toBe('neon alley');
    expect(wf['3'].inputs.text).toBe('');
    expect(wf['1'].inputs.ckpt_name).toBe('flux1-dev-fp8.safetensors');
    expect(wf['5'].inputs.steps).toBe(12);
    expect(wf['5'].inputs.cfg).toBe(1.0);
    expect(wf['4'].inputs.width).toBe(768);
    expect(wf['4'].inputs.height).toBe(1344);
  });

  it('verdrahtet den Sampler auf die Textknoten (sonst wirkt der Prompt nicht)', () => {
    const wf = fluxVisionWorkflow({ prompt: 'x' }) as Record<string, { inputs: Record<string, unknown> }>;
    expect(wf['5'].inputs.positive).toEqual(['2', 0]);
    expect(wf['5'].inputs.negative).toEqual(['3', 0]);
    expect(wf['5'].inputs.model).toEqual(['1', 0]);
  });

  it('macht aus rohem base64 der Worker-Antwort einen data-URI', () => {
    // Live-Form von worker-comfyui: { filename, type: 'base64', data: 'iVBORw0…' }
    expect(extractVisionImage({ images: [{ filename: 'vision_00001_.png', type: 'base64', data: 'iVBORw0KGgo' }] })).toBe(
      'data:image/png;base64,iVBORw0KGgo',
    );
  });

  it('nimmt bei S3-Ausgabe den Pfad als URL und verpackt ihn nicht', () => {
    expect(extractVisionImage({ images: [{ filename: 'a.png', type: 's3', data: 's3://bucket/a.png' }] })).toBe(
      's3://bucket/a.png',
    );
  });

  it('laesst den alten image_url-Weg weiter funktionieren', () => {
    expect(extractVisionImage({ image_url: DATA_URI })).toBe(DATA_URI);
  });
});
