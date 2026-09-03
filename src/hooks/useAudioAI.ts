import { useState, useEffect } from 'react';
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

export const useAIStatus = () => {
    const [isOnline, setIsOnline] = useState<boolean | null>(null);

    useEffect(() => {
        const checkStatus = async () => {
            try {
                await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
                setIsOnline(true);
            } catch (e) {
                setIsOnline(false);
            }
        };
        checkStatus();
        const interval = setInterval(checkStatus, 30000); // Check every 30s
        return () => clearInterval(interval);
    }, []);

    return { isOnline };
};

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

  const streamStems = async function* (file: File) { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE_URL}/separate-stems`, {
            method: 'POST',
            body: formData
        });

        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Handle SSE lines
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    if (data.progress) yield data.progress;
                    if (data.status === 'success') {
                        return { status: 'success', stems: data.stems, provider: (data.provider as string | undefined) ?? 'server' };
                    }
                }
            }

            // Nicht-SSE-Antworten (z. B. Replicate-Pfad liefert Plain-JSON):
            // Buffer als Ganzes parsen, falls er ein fertiges JSON-Objekt ist.
            const trimmed = buffer.trim();
            if (trimmed.startsWith('{')) {
                try {
                    const data = JSON.parse(trimmed);
                    if (data.status === 'success') {
                        return { status: 'success', stems: data.stems, provider: (data.provider as string | undefined) ?? 'server' };
                    }
                } catch { /* kein JSON – ignorieren */ }
            }
        }
    } catch (error) {
        console.warn("AI service unreachable, using mock fallback.", error);
        // Simulate progress
        for(let i=10; i<=100; i+=10) {
            await new Promise(r => setTimeout(r, 200));
            yield i;
        }
        return {
            status: 'mocked',
            provider: 'fallback',
            stems: {
                vocals: 'mock_url_vocals',
                melody: 'mock_url_melody',
                highs: 'mock_url_highs',
                mids: 'mock_url_mids',
                lows: 'mock_url_lows'
            }
        };
    }
  };

  const separateStems = async (file: File) => {
    // Legacy support
    const stream = streamStems(file);
    let last;
    for await (const val of stream) { last = val; }
    return last;
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
