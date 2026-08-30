/**
 * audioMONASTRY · 4.1.3 – Lokale Voice-Synthese (VITS/Coqui + WebSpeech)
 * =======================================================================
 * Offline-fähige TTS/Singing-Pipeline: bevorzugt ein lokales CLI
 * (VITS/Coqui via env), sonst Browser-WebSpeech, sonst deterministischer Stub.
 */

export interface VoiceResult {
  url?: string;
  text: string;
  engine: 'vits' | 'webspeech' | 'deterministic';
}

/** Deterministischer Stub (kein Netz, kein Modell). */
export function deterministicVoice(text: string): VoiceResult {
  return { text, engine: 'deterministic' };
}

/** Browser-WebSpeech-Synthese (offline-fähig, wenn Stimmen installiert). */
export function webSpeechVoice(text: string): VoiceResult {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utter);
    return { text, engine: 'webspeech' };
  }
  return deterministicVoice(text);
}

/**
 * Lokale TTS-Pipeline: CLI (falls konfiguriert) → WebSpeech → deterministisch.
 * Konfiguration: VOICE_ENGINE=vits|rvc, VOICE_CLI=/pfad/zum/predict
 */
export async function synthesizeVoiceLocal(
  text: string,
  voicePreset = 'FEMALE_ROBOTIC',
): Promise<VoiceResult> {
  const engine = (import.meta.env?.VITE_VOICE_ENGINE ?? '').trim().toLowerCase();
  const cli = (import.meta.env?.VITE_VOICE_CLI ?? '').trim();
  if (engine && cli && text) {
    // Produktivpfad: CLI-Aufruf über die Server-API (POST /api/generate-voice),
    // damit keine Shell im Browser nötig ist.
    try {
      const resp = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voicePreset }),
      });
      const data = await resp.json() as { url?: string };
      if (resp.ok && data.url) return { url: data.url, text, engine: 'vits' };
    } catch { /* Server nicht erreichbar → WebSpeech */ }
  }
  return webSpeechVoice(text);
}
