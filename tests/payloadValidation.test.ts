import { describe, expect, it } from 'vitest';
import {
  AlertsWebhookSchema,
  GenerateVoiceSchema,
  JsonObjectBodySchema,
  LibrarySearchSchema,
  McpToolInvokeSchema,
  SoundGenerateSchema,
  VoiceSingSchema,
  VoiceSongSchema,
  VoiceTtsSchema,
  boundedJsonObjectSchema,
} from '../src/types/zod/schemas';

describe('SEC-P1-001 – Voice-/Sound-/Song-Payloads', () => {
  it('nimmt gültige Payloads an', () => {
    expect(GenerateVoiceSchema.safeParse({ text: 'Hallo', voicePreset: 'FEMALE_ROBOTIC' }).success).toBe(true);
    expect(VoiceTtsSchema.safeParse({ text: 'Hallo', language: 'de', speaker: 'berta' }).success).toBe(true);
    expect(VoiceSingSchema.safeParse({ text: 'La la', model: 'suno/bark' }).success).toBe(true);
    expect(VoiceSongSchema.safeParse({ prompt: 'Techno', durationSeconds: 8, style: 'dark', bpm: 128 }).success).toBe(true);
    expect(SoundGenerateSchema.safeParse({ kind: 'kick', prompt: 'tight kick', durationSeconds: 2 }).success).toBe(true);
  });

  it('weist Typ-Verwirrung ab (statt sie bis in die Route zu lassen)', () => {
    expect(VoiceTtsSchema.safeParse({ text: { böse: true } }).success).toBe(false);
    expect(VoiceSongSchema.safeParse({ prompt: ['a', 'b'] }).success).toBe(false);
    expect(SoundGenerateSchema.safeParse({ durationSeconds: 'viel' }).success).toBe(false);
    expect(LibrarySearchSchema.safeParse({ limit: { n: 3 } }).success).toBe(false);
  });

  it('klemmt absurde Werte ab, lässt aber die Kürzung der Route zu', () => {
    // 4000 Zeichen sind erlaubt (die Route kürzt selbst auf 500) …
    expect(VoiceTtsSchema.safeParse({ text: 'a'.repeat(4000) }).success).toBe(true);
    // … 100 000 Zeichen nicht mehr (DoS-Bremse).
    expect(VoiceTtsSchema.safeParse({ text: 'a'.repeat(100_000) }).success).toBe(false);
    expect(VoiceSongSchema.safeParse({ durationSeconds: 10_000 }).success).toBe(false);
    expect(VoiceSongSchema.safeParse({ bpm: 5 }).success).toBe(false);
  });

  it('prüft das Voice-Preset-Muster', () => {
    expect(GenerateVoiceSchema.safeParse({ voicePreset: 'FEMALE_ROBOTIC' }).success).toBe(true);
    expect(GenerateVoiceSchema.safeParse({ voicePreset: 'böse preset!' }).success).toBe(false);
    expect(GenerateVoiceSchema.safeParse({ voicePreset: 'a'.repeat(40) }).success).toBe(false);
  });

  it('erlaubt leere Bodies (die Routen melden „text fehlt" selbst)', () => {
    expect(VoiceTtsSchema.safeParse({}).success).toBe(true);
    expect(VoiceSongSchema.safeParse({}).success).toBe(true);
    expect(GenerateVoiceSchema.safeParse({}).success).toBe(true);
  });

  it('verlangt bei der Bibliotheks-Suche Typen und Grenzen', () => {
    expect(LibrarySearchSchema.safeParse({ query: 'Acid Bass', limit: 5 }).success).toBe(true);
    expect(LibrarySearchSchema.safeParse({ query: 'x'.repeat(500) }).success).toBe(false);
    expect(LibrarySearchSchema.safeParse({ limit: 999 }).success).toBe(false);
  });
});

describe('SEC-P1-001 – MCP-Argumente und Proxy-Hülle', () => {
  it('lässt beliebige Tool-Argumente zu, begrenzt aber die Größe', () => {
    expect(McpToolInvokeSchema.safeParse({ bpm: 128, pattern: ['k', 'h'], nested: { a: 1 } }).success).toBe(true);
    expect(McpToolInvokeSchema.safeParse({ arg: 'x'.repeat(30_000) }).success).toBe(false);
    expect(McpToolInvokeSchema.safeParse('kein-objekt').success).toBe(false);
    expect(McpToolInvokeSchema.safeParse({ ['k'.repeat(200)]: 1 }).success).toBe(false);
  });

  it('deckelt die Proxy-Hülle separat (256 kB) und ist parametrierbar', () => {
    const big = { mix: 'x'.repeat(300_000) };
    expect(JsonObjectBodySchema.safeParse(big).success).toBe(false);
    expect(JsonObjectBodySchema.safeParse({ mix: 'x'.repeat(1000) }).success).toBe(true);

    const tiny = boundedJsonObjectSchema(50, 'zu gross');
    expect(tiny.safeParse({ a: 'x'.repeat(100) }).success).toBe(false);
    expect(tiny.safeParse({ a: 'ok' }).success).toBe(true);
  });
});

describe('SEC-P1-001 – Alertmanager-Webhook', () => {
  it('nimmt eine typische Alertmanager-Nutzlast an', () => {
    const payload = {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'AppDown', severity: 'critical' },
          annotations: { summary: 'app-1 antwortet nicht' },
          startsAt: '2026-09-11T12:00:00Z',
        },
      ],
    };
    expect(AlertsWebhookSchema.safeParse(payload).success).toBe(true);
    expect(AlertsWebhookSchema.safeParse({}).success).toBe(true);
  });

  it('weist falsche Typen und Massen-Payloads ab', () => {
    expect(AlertsWebhookSchema.safeParse({ alerts: { status: 'firing' } }).success).toBe(false);
    expect(AlertsWebhookSchema.safeParse({ alerts: [{ labels: 'text statt objekt' }] }).success).toBe(false);
    expect(AlertsWebhookSchema.safeParse({ alerts: Array.from({ length: 101 }, () => ({})) }).success).toBe(false);
  });
});
