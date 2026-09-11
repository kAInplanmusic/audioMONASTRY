/**
 * audioMONASTRY · AudioContext-Factory (Plattform-Kapsel)
 * ========================================================
 * Erzeugt Analyse-/Diagnose-AudioContexts, ohne dass Analyse-Module die
 * Plattform-API direkt anfassen (Interface-Boundary-Regel 1.1 / IAudioBackend).
 */

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

export interface AudioContextSettings {
  /** 'interactive' | 'balanced' | 'playback' oder Zahl (Sekunden). */
  latencyHint?: AudioContextLatencyCategory | number;
  sampleRate?: number;
}

/** Reine Options-Auflösung für Tests (serverlos). */
export function resolveAudioContextOptions(settings: AudioContextSettings = {}): AudioContextOptions {
  const options: AudioContextOptions = {};
  if (settings.latencyHint !== undefined) options.latencyHint = settings.latencyHint;
  if (Number.isFinite(settings.sampleRate) && (settings.sampleRate as number) > 0) {
    options.sampleRate = settings.sampleRate;
  }
  return options;
}

function getAudioContextCtor(): AudioContextCtor | null {
  const win = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/** Erzeugt einen AudioContext mit den gespeicherten AudioSettings (P2-1/P1-3). */
function createConfiguredAudioContext(settings: AudioContextSettings = {}): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor(resolveAudioContextOptions(settings));
  } catch {
    // Fallback: Browser akzeptiert Optionen nicht (z. B. sampleRate 96k)
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

/** Erzeugt einen frischen AudioContext (z. B. zum Offline-Dekodieren). */
export function createAnalysisAudioContext(): AudioContext | null {
  return createConfiguredAudioContext({ latencyHint: 'playback' });
}

