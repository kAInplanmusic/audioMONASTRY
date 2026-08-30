/**
 * audioMONASTRY · VoiceMONK HF-Proxy-Client
 * ==========================================
 * Im Browser laufen alle Hugging-Face-Aufrufe (TTS/Gesang/Song) über den
 * gleichen Origin: `POST /api/voice/<task>`. Der Express-Server hält den
 * HF_API_KEY und die Modell-Auswahl serverseitig – der Client bekommt nur
 * die fertige Audio-Datei zurück und niemals einen Key.
 */

export type HfVoiceTask = 'tts' | 'sing' | 'song';

export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export async function hfVoiceRequest(task: HfVoiceTask, payload: Record<string, unknown>): Promise<Blob> {
  const resp = await fetch(`/api/voice/${task}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Voice-API ${task} HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return await resp.blob();
}
