import { describe, expect, it, vi } from 'vitest';
import { VISION_STYLES, VISION_STYLE_SUFFIX, buildVisionPrompt, suggestVisionStyle } from '../src/core/ai/vision/visionPrompt';
import { VisionError, extractVisionImage, generateVisionImage, visionEndpointId } from '../src/core/ai/vision/runpodVision';
import { AiVisionSchema } from '../src/types/zod/schemas';

const DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

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

  it('liefert das Bild aus einem COMPLETED-Job', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'j1', status: 'COMPLETED', output: { image_url: DATA_URI, seed: 42 } }) })) as unknown as typeof fetch;
    const res = await generateVisionImage('test', { endpointId: 'ep', apiKey: 'k', fetchImpl, pollIntervalMs: 1 });
    expect(res.image).toBe(DATA_URI);
    expect(res.seed).toBe(42);
    expect(res.prompt).toBe('test');
  });

  it('pollt bei kaltem Worker bis COMPLETED', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ id: 'j2', status: 'IN_QUEUE' }) };
      return { ok: true, status: 200, json: async () => ({ id: 'j2', status: 'COMPLETED', output: { images: [DATA_URI] } }) };
    }) as unknown as typeof fetch;
    const res = await generateVisionImage('p', { endpointId: 'ep', apiKey: 'k', fetchImpl, pollIntervalMs: 1 });
    expect(res.image).toBe(DATA_URI);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('wirft typisierte Fehler bei fehlendem Endpoint/Key und bei Job-Fehler', async () => {
    await expect(generateVisionImage('p', { endpointId: '', apiKey: 'k' })).rejects.toBeInstanceOf(VisionError);
    await expect(generateVisionImage('p', { endpointId: 'ep', apiKey: '' })).rejects.toMatchObject({ code: 'NO_KEY' });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'j3', status: 'FAILED' }) })) as unknown as typeof fetch;
    await expect(generateVisionImage('p', { endpointId: 'ep', apiKey: 'k', fetchImpl, pollIntervalMs: 1 })).rejects.toMatchObject({ code: 'FAILED' });
  });

  it('liest die Endpoint-ID aus der Umgebung', () => {
    const prev = process.env.RUNPOD_ENDPOINT_ID_VISION;
    process.env.RUNPOD_ENDPOINT_ID_VISION = 'vision-ep-1';
    expect(visionEndpointId()).toBe('vision-ep-1');
    if (prev === undefined) delete process.env.RUNPOD_ENDPOINT_ID_VISION;
    else process.env.RUNPOD_ENDPOINT_ID_VISION = prev;
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
