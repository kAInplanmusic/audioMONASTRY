/**
 * audioMONASTRY · Phase 4 – Speech-to-Intent Pipeline
 * ====================================================
 * Wandelt gesprochene/geschriebene Befehle in strukturierte Intents um.
 * OpenAI dient als Control-Layer; lokale Voice Engine bleibt Synthese-Backend.
 */

export interface VoiceIntent {
  action: 'play' | 'stop' | 'set_tempo' | 'assign_plugin' | 'automate' | 'unknown';
  targets: string[];
  parameters: Record<string, number | string>;
  confidence: number;
  raw: string;
}

export interface ISpeechToIntent {
  parse(command: string): Promise<VoiceIntent>;
}

/** Regelbasierter Mock-Interpreter für Tests und Offline-Betrieb. */
export class RuleBasedSpeechToIntent implements ISpeechToIntent {
  async parse(command: string): Promise<VoiceIntent> {
    const raw = command.trim().toLowerCase();

    if (/^(?:stop|halt|pause)/.test(raw)) {
      return { action: 'stop', targets: ['transport'], parameters: {}, confidence: 0.9, raw: command };
    }
    if (/tempo|bpm/.test(raw)) {
      const m = raw.match(/(\d{2,3})/);
      return {
        action: 'set_tempo',
        targets: ['transport'],
        parameters: { bpm: m ? Number(m[1]) : 120 },
        confidence: m ? 0.85 : 0.5,
        raw: command,
      };
    }
    if (/automat|filter|cue/.test(raw)) {
      return { action: 'automate', targets: ['fx'], parameters: { command }, confidence: 0.6, raw: command };
    }
    if (/plugin|modul/.test(raw)) {
      return { action: 'assign_plugin', targets: raw.split(/\s+/), parameters: {}, confidence: 0.4, raw: command };
    }
    if (/^(?:play|start|los)/.test(raw)) {
      return { action: 'play', targets: ['transport'], parameters: {}, confidence: 0.8, raw: command };
    }
    return { action: 'unknown', targets: [], parameters: {}, confidence: 0, raw: command };
  }
}
