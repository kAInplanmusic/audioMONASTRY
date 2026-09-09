import { describe, expect, it } from 'vitest';
import {
  AiCompleteSchema,
  AiGenerateDropSchema,
  AiOrchestrateSchema,
  CloudSampleSchema,
  CloudUploadJsonSchema,
  PluginStateSocketSchema,
  TelemetryPayloadSchema,
} from '../src/types/zod/schemas';

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
});
