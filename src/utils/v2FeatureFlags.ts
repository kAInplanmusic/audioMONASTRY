/**
 * audioMONASTRY · V2 Feature-Flags (Phase 7 – UI-Umstellung)
 * ==========================================================
 * Zentrale Entscheidung, ob die App im V1- oder V2-Audiopfad startet.
 *
 * Flags (Vite-Env, ohne Plattform-API):
 *   VITE_V2_AUDIO_MODE      = 'v1' | 'v2'   (Default 'v1' – sicherer Fallback)
 *   VITE_V2_AUDIO_ONLY      = '1'            (V1-Pfad vollständig ausblenden)
 *
 * `.env.example` dokumentiert den Produktiv-Umstieg auf `v2`.
 */

export type AudioPlaybackMode = 'v1' | 'v2';

export interface V2AudioFlagEnv {
  VITE_V2_AUDIO_MODE?: string;
  VITE_V2_AUDIO_ONLY?: string;
}

function readEnv(): V2AudioFlagEnv {
  try {
    return ((import.meta as unknown as { env?: V2AudioFlagEnv }).env ?? {}) as V2AudioFlagEnv;
  } catch {
    return {};
  }
}

/** Liefert den initialen Audio-Pfad aus der Feature-Flag-Konfiguration. */
export function initialPlaybackMode(env: V2AudioFlagEnv = readEnv()): AudioPlaybackMode {
  const mode = String(env.VITE_V2_AUDIO_MODE ?? '').trim().toLowerCase();
  if (mode === 'v2' || mode === '1' || mode === 'true') return 'v2';
  return 'v1';
}

/** V1-Pfad ist nur erlaubt, wenn nicht `VITE_V2_AUDIO_ONLY=1` gesetzt ist. */
export function isV1PlaybackAllowed(env: V2AudioFlagEnv = readEnv()): boolean {
  return String(env.VITE_V2_AUDIO_ONLY ?? '').trim() !== '1';
}

/** V2-Pfad ist erlaubt, solange nicht explizit auf v1 gezwungen wurde. */
export function isV2PlaybackAllowed(env: V2AudioFlagEnv = readEnv()): boolean {
  return String(env.VITE_V2_AUDIO_MODE ?? '').trim().toLowerCase() !== 'v1';
}

/** Setzt einen Wunschmodus gegen die Feature-Flags durch (defensiv). */
export function resolvePlaybackMode(
  requested: AudioPlaybackMode,
  env: V2AudioFlagEnv = readEnv(),
): AudioPlaybackMode {
  if (requested === 'v2' && isV2PlaybackAllowed(env)) return 'v2';
  if (requested === 'v1' && isV1PlaybackAllowed(env)) return 'v1';
  return initialPlaybackMode(env);
}
