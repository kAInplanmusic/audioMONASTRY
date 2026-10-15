import { API_BASE_URL } from '../config/runtime';

/** fetch mit Timeout (ersetzt axios – Bundle-Diät P2-5). */
async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Optionen für die Server-Trennung (FLEET-P1-006). */
export interface StemRequestOptions {
  /** auto = RP5, sonst (nur wenn RP5 fehlt) 4-Stem-Modus; 5stem = nur RP5; 4stem = nur stem-ai. */
  mode?: 'auto' | '5stem' | '4stem';
  /** Projekt-BPM: Stems werden darauf gewarpt (Plugin #11). */
  targetBpm?: number;
  /** Ziel-Tonart (z. B. "Am"); leer = Tonart bleibt. */
  targetKey?: string;
  signal?: AbortSignal;
}

/** Server-Antwort von /api/separate-stems (URLs, nie Base64). */
export interface StemServerResult {
  status: 'success' | 'error';
  provider?: string;
  mode?: '5stem' | '4stem';
  model?: string;
  stems?: Record<string, string>;
  stemSet?: string[];
  melodyAvailable?: boolean;
  notes?: string[];
  library?: { id: string; key: string; name: string; category: 'bass' | 'mids' | 'highs'; description: string; url: string; tags?: string[] }[];
  warp?: { applied?: boolean; sourceBpm?: number; targetBpm?: number; stretch?: number; semitones?: number; sourceKey?: string; targetKey?: string };
  fallbackReason?: string;
  simulated?: boolean;
  code?: string;
  message?: string;
  hint?: string;
  fourStemAvailable?: boolean;
}

export const useAudioAI = () => {

  const fetchWithRetry = async (apiCall: () => Promise<any>, retries = 3): Promise<any> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await apiCall();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000)); // Exponential backoff
        }
    }
  };

  /**
   * stemMONK → Server (FLEET-P1-006). Der Server trennt über RP5 (5 Stems) bzw.
   * ausdrücklich im 4-Stem-Modus (stem-ai) und antwortet mit URLs (nie Base64).
   * Fortschritt (Zahlen) kommt nur vom simulierten Stub (SSE). Fehler kommen als
   * `{ status: 'error', code, message, hint }` zurück – es gibt KEIN Schein-Ergebnis.
   */
  const streamStems = async function* (file: File, options: StemRequestOptions = {}): AsyncGenerator<number, StemServerResult, void> { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mode', options.mode ?? 'auto');
        if (options.targetBpm && Number.isFinite(options.targetBpm)) formData.append('targetBpm', String(Math.round(options.targetBpm * 100) / 100));
        if (options.targetKey) formData.append('targetKey', options.targetKey);

        const response = await fetch(`${API_BASE_URL}/separate-stems`, {
            method: 'POST',
            body: formData,
            signal: options.signal,
        });

        if ((response.headers.get('content-type') ?? '').includes('application/json') || !response.body) {
            const data = await response.json().catch(() => ({})) as StemServerResult;
            if (!response.ok || data.status !== 'success') {
                return { ...data, status: 'error', code: data.code ?? `HTTP_${response.status}`, message: data.message ?? (data as { error?: string }).error ?? `Server antwortet ${response.status}` };
            }
            return data;
        }

        // SSE (nur der simulierte Stub, STEM_AI_PROVIDER=fallback).
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = JSON.parse(line.slice(6));
                if (data.progress) yield data.progress;
                if (data.status === 'success') return data as StemServerResult;
            }
        }
        return { status: 'error', code: 'NO_RESULT', message: 'Server-Antwort ohne Ergebnis.' };
    } catch (error) {
        if ((error as Error)?.name === 'AbortError') return { status: 'error', code: 'CANCELLED', message: 'Abgebrochen.' };
        console.warn('Stem-Server nicht erreichbar.', error);
        return { status: 'error', code: 'NETWORK', message: 'Stem-Server nicht erreichbar.' };
    }
  };

  const separateStems = async (file: File, options: StemRequestOptions = {}): Promise<StemServerResult> => {
    const stream = streamStems(file, options);
    while (true) {
      const step = await stream.next();
      if (step.done) return step.value;
    }
  };

  const generateVoice = async (text: string, voicePreset: string) => {
    // P5: Zuerst den (verbesserten) lokalen Server-Endpunkt /api/generate-voice
    // anfragen. Der Server liefert 'ok' (RVC/VITS-Engine via env) oder
    // 'local' (dann Web-Speech). Bei Netzwerk-/Serverfehler fällt auf
    // Browser-Web-Speech zurück (kein Cloud-TTS nötig).
    try {
      const data = await fetchWithRetry(async () => {
          return fetchJson(`${API_BASE_URL}/generate-voice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voicePreset }),
          });
      });

      const status: string = data?.status ?? 'local';
      if (status === 'ok') {
        return { status: 'ok', url: data.url, text, voicePreset };
      }
      if (status === 'local' || status === 'error') {
        // Kein echter Engine verfügbar -> Web-Speech-Fallback.
        throw new Error('voice-engine_unavailable');
      }
      return data;
    } catch (error) {
      const isEngineUnavailable = (error as Error).message === 'voice-engine_unavailable';
      console.warn(
        isEngineUnavailable
          ? 'Voice-Engine nicht aktiviert; nutze Web-Speech.'
          : 'Voice-Service nicht erreichbar; nutze Web-Speech.',
        error,
      );

      // Browser-Web-Speech-Fallback (deterministisch, offline, keine Cloud).
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          const synth = window.speechSynthesis;
          const speak = new Promise<string>((resolve) => {
            const utter = new SpeechSynthesisUtterance(text);
            const voices = synth.getVoices();
            const match = voices.find(v => v.lang === voicePreset) || voices[0];
            if (match) utter.voice = match;
            utter.rate = 0.95;
            utter.volume = 1;
            utter.onend = () => resolve('ok-spoken');
            utter.onerror = () => resolve('error-speech');
            synth.speak(utter);
          });
          await Promise.race([speak, new Promise(r => setTimeout(r, 1500))]);
          return { status: 'spoken', url: null, text, voicePreset };
        } catch (e) {
          console.warn('Web-Speech nicht verfügbar, verwende Mock.', e);
        }
      }

      // End-Fallback: deterministischer lokaler Mock (kein Netz).
      return {
        status: 'mocked',
        url: `mock_voice_url_${voicePreset}`,
        text,
        voicePreset,
      };
    }
  };

  return { separateStems, streamStems, generateVoice };
};
