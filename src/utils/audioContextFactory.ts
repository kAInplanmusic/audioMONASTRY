/**
 * audioMONASTRY · AudioContext-Factory (Plattform-Kapsel)
 * ========================================================
 * Erzeugt Analyse-/Diagnose-AudioContexts, ohne dass Analyse-Module die
 * Plattform-API direkt anfassen (Interface-Boundary-Regel 1.1 / IAudioBackend).
 */

type AudioContextCtor = new () => AudioContext;

export function getAudioContextCtor(): AudioContextCtor | null {
  const win = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/** Erzeugt einen frischen AudioContext (z. B. zum Offline-Dekodieren). */
export function createAnalysisAudioContext(): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** Audio-System-Diagnose: Kanal-/Kontext-Check (ohne direkte Plattform-API). */
export async function checkAudioSystem(): Promise<void> {
  const ctx = createAnalysisAudioContext();
  if (!ctx) {
    console.warn('WARNUNG: Kein AudioContext verfügbar.');
    return;
  }
  try {
    if (ctx.destination.channelCount < 8) {
      console.warn('WARNUNG: System unterstützt weniger als 8 Kanäle. Spatial-Surround (8.1/10.1) könnte eingeschränkt sein.');
    }
  } finally {
    await ctx.close().catch(() => { /* ignore */ });
  }
}
