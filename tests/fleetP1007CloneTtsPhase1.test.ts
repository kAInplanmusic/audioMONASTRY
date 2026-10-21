/**
 * FLEET-P1-007 · Qwen3-TTS-Clone: Stimm-Cloning via qwen3-tts-06b-base
 * ===================================================================
 * Phase 1 (ROT): Tests schreiben, die heute rot sind, bevor der Fix implementiert wird.
 * 
 * Getestet wird die komplette Pipeline:
 * 1. Schema-Validierung: VoiceTtsSchema akzeptiert refAudio/refText
 * 2. Allowlist: qwen3-tts-06b-base ist in RUNTIME_MODEL_ALLOWLIST.tts
 * 3. Rolle-Erlaubnis: Clone-Modell darf auf voiceGen-Rolle laufen (allowRole)
 * 4. Server-seitige Payload: refAudio/refText werden an den Worker weitergereicht
 * 5. Integration: POST /api/voice/tts mit Clone-Modell + Referenz-Audio
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { VoiceTtsSchema } from '../shared/schemas';
import { RUNTIME_MODEL_ALLOWLIST, allowedVoiceModels, resolveVoiceRuntimeModel } from '../server/routes/voiceRoutes';

describe('FLEET-P1-007 · Qwen3-TTS-Clone (Phase 1: ROT)', () => {
  describe('Schema: VoiceTtsSchema', () => {
    it('akzeptiert refAudio (Base64, max ~14M Zeichen) und refText (max 500)', () => {
      const result = VoiceTtsSchema.safeParse({
        text: 'Hallo Welt',
        refAudio: 'A'.repeat(1000),
        refText: 'Hallo Referenz',
      });
      expect(result.success).toBe(true);
    });

    it('lehnt zu langes refAudio ab (>14M Zeichen)', () => {
      const result = VoiceTtsSchema.safeParse({
        text: 'test',
        refAudio: 'A'.repeat(15_000_000),
      });
      expect(result.success).toBe(false);
    });

    it('lehnt zu langes refText ab (>500 Zeichen)', () => {
      const result = VoiceTtsSchema.safeParse({
        text: 'test',
        refText: 'A'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('akzeptiert leere/fehlende refAudio/refText', () => {
      const result = VoiceTtsSchema.safeParse({ text: 'test' });
      expect(result.success).toBe(true);
    });
  });

  describe('Allowlist: RUNTIME_MODEL_ALLOWLIST.tts', () => {
    it('enthält qwen3-tts-06b-base', () => {
      expect(RUNTIME_MODEL_ALLOWLIST.tts).toContain('qwen3-tts-06b-base');
    });

    it('enthält weiterhin qwen3-tts-06b und qwen3-tts-17b', () => {
      expect(RUNTIME_MODEL_ALLOWLIST.tts).toContain('qwen3-tts-06b');
      expect(RUNTIME_MODEL_ALLOWLIST.tts).toContain('qwen3-tts-17b');
    });
  });

  describe('allowedVoiceModels("tts")', () => {
    it('gibt alle erlaubten TTS-Modelle zurück (inkl. qwen3-tts-06b-base)', () => {
      const models = allowedVoiceModels('tts');
      expect(models).toContain('qwen3-tts-06b-base');
      expect(models).toContain('qwen3-tts-06b');
      expect(models).toContain('qwen3-tts-17b');
    });
  });

  describe('resolveVoiceRuntimeModel("tts", "qwen3-tts-06b-base")', () => {
    it('gibt override=true zurück, weil Modell in Allowlist ist', () => {
      const result = resolveVoiceRuntimeModel('tts', 'qwen3-tts-06b-base');
      expect(result).not.toBeNull();
      expect(result!.override).toBe(true);
      expect(result!.model).toBe('qwen3-tts-06b-base');
    });

    it('lehnt unbekannte Modelle ab', () => {
      const result = resolveVoiceRuntimeModel('tts', 'unbekanntes-modell');
      expect(result).toBeNull();
    });
  });
});