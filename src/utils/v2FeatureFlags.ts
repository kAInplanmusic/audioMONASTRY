/**
 * audioMONASTRY · V2 Feature-Flags (Phase 9 – V1-Cutover)
 * ==========================================================
 * Der V1-Audiopfad (Tone.js/audioEngine-Monolith-Scheduler) ist ab
 * Phase 9 deaktiviert. V2 ist der einzige Produktiv-Audiopfad.
 *
 * Die Flags bleiben als dokumentierte, defensive API erhalten:
 *   VITE_V2_AUDIO_MODE  = 'v2' (einziger gültiger Wert)
 *   VITE_V2_AUDIO_ONLY  = '1'  (historisch; ohne Wirkung, da V1 entfernt ist)
 *
 * `resolvePlaybackMode` erzwingt immer 'v2' – es existiert kein
 * paralleler V1-Produktionspfad mehr (ARCH-PLUGIN-006).
 */

export type AudioPlaybackMode = 'v2';

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

/** Liefert den initialen Audio-Pfad – nach dem V1-Cutover immer 'v2'. */
export function initialPlaybackMode(_env: V2AudioFlagEnv = readEnv()): AudioPlaybackMode {
  return 'v2';
}

/** Der V1-Pfad ist nach Phase 9 nicht mehr erlaubt. */
export function isV1PlaybackAllowed(_env: V2AudioFlagEnv = readEnv()): boolean {
  return false;
}

/** Der V2-Pfad ist immer erlaubt. */
export function isV2PlaybackAllowed(_env: V2AudioFlagEnv = readEnv()): boolean {
  return true;
}

/** Setzt einen Wunschmodus durch (defensiv) – es gewinnt immer V2. */
export function resolvePlaybackMode(
  _requested: AudioPlaybackMode,
  _env: V2AudioFlagEnv = readEnv(),
): AudioPlaybackMode {
  return 'v2';
}
