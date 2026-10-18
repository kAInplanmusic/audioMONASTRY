import { describe, expect, it } from 'vitest';
import {
  AiCompleteSchema,
  AiGenerateDropSchema,
  AiOrchestrateSchema,
  CloudSampleSchema,
  CloudUploadJsonSchema,
  PluginStateSocketSchema,
  TelemetryPayloadSchema,
} from '../shared/schemas.ts';

describe('ARCH-SEC-003 · Zod Server-Payload-Schemas', () => {
  it('TelemetryPayloadSchema: gültige Events passieren, >50 Events werden abgelehnt', () => {
    const ok = TelemetryPayloadSchema.safeParse({
      events: [{ type: 'dropout', source: 'audio-thread', message: 'x' }],
    });
    expect(ok.success).toBe(true);

    const tooMany = TelemetryPayloadSchema.safeParse({
      events: Array.from({ length: 51 }, () => ({ type: 'x', source: 'y', message: 'z' })),
    });
    expect(tooMany.success).toBe(false);
  });

  it('CloudSampleSchema: Kategorie muss bass/mids/highs sein', () => {
    const ok = CloudSampleSchema.safeParse({
      id: 's1', name: 'Kick', category: 'bass', type: 'kick',
    });
    expect(ok.success).toBe(true);

    const bad = CloudSampleSchema.safeParse({
      id: 's1', name: 'Kick', category: 'evil', type: 'kick',
    });
    expect(bad.success).toBe(false);
  });

  it('CloudUploadJsonSchema: Key-Whitelist verhindert Path-Traversal', () => {
    const ok = CloudUploadJsonSchema.safeParse({ key: 'uploads/test.wav', dataBase64: 'AA==' });
    expect(ok.success).toBe(true);

    const traversal = CloudUploadJsonSchema.safeParse({ key: '../evil.wav', dataBase64: 'AA==' });
    expect(traversal.success).toBe(false);
  });

  it('AiCompleteSchema: leerer/überlanger Prompt wird abgelehnt', () => {
    expect(AiCompleteSchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(AiCompleteSchema.safeParse({ prompt: 'A'.repeat(8001) }).success).toBe(false);
    expect(AiCompleteSchema.safeParse({ prompt: 'Mix-Tipp' }).success).toBe(true);
  });

  it('AiGenerateDropSchema: userPrompt oder prompt erforderlich', () => {
    expect(AiGenerateDropSchema.safeParse({}).success).toBe(false);
    expect(AiGenerateDropSchema.safeParse({ userPrompt: 'Drop!' }).success).toBe(true);
  });

  it('AiOrchestrateSchema: task/model Pflichtfelder', () => {
    expect(AiOrchestrateSchema.safeParse({}).success).toBe(false);
    expect(AiOrchestrateSchema.safeParse({ task: 'audio.transcribe', model: 'whisper-large-v3' }).success).toBe(true);
  });

  it('PluginStateSocketSchema: nur bekannte States', () => {
    expect(PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'PRO' }).success).toBe(true);
    expect(PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'HACK' }).success).toBe(false);
  });

  it('COLLAB-P0-005: baseRevision wird NICHT weggestrippt (Zod-Falle)', () => {
    // Der Socket-Pfad validiert gegen dieses Schema; Zod entfernt unbekannte
    // Keys. Fehlte `baseRevision` hier, kaeme sie im Server nie an und die
    // optimistische Nebenlaeufigkeit waere auf dem Socket-Pfad wirkungslos
    // (genau so ist der Relay-Pfad 2026-10 einmal stumm geworden).
    const parsed = PluginStateSocketSchema.safeParse({
      pluginId: 'mixer',
      state: 'PRO',
      eventId: 'u1:abc:1',
      sequence: 1,
      timestamp: 1_700_000_000_000,
      baseRevision: 7,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.baseRevision).toBe(7);
    // 0 ist ein gueltiger Wert (Plugin wurde nie geschrieben) ...
    expect(PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'PRO', baseRevision: 0 }).success).toBe(true);
    // ... negativ und gebrochen sind es nicht.
    expect(PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'PRO', baseRevision: -1 }).success).toBe(false);
    expect(PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'PRO', baseRevision: 1.5 }).success).toBe(false);
    // Ohne Feld bleibt das Altverhalten (keine Pruefung).
    const without = PluginStateSocketSchema.safeParse({ pluginId: 'mixer', state: 'PRO' });
    expect(without.success && without.data.baseRevision).toBeUndefined();
  });
});
