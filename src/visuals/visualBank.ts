/**
 * VisualMONK · Vorlagen-Bank (L1-Anker) — öffentliche R2-Clips
 * =============================================================
 * Acht kuratierte Image-to-Video-Clips (Wan 2.2 TI2V), je aus einem geprüften
 * Vorratsbild. Die Clips liegen öffentlich in R2, werden dem Browser aber über
 * den eigenen App-Server ausgeliefert (`/api/ai/vision/bank/<id>`) — gemessen
 * (28.09.2026) sendet der R2-Bucket **keinen** `Access-Control-Allow-Origin`,
 * und ohne same-origin-Auslieferung wäre das Show-Canvas „tainted" und der
 * Beamer/Main-Out schwarz. Quelle der Kennzahlen: `vorlagen/vorlagen.json`,
 * `docs/VISUALVORLAGEN.md`.
 *
 * Das ist der „Vorrat reicht erstmal“-Pfad: 0 USD, kein RunPod-Aufruf. Neues
 * Material kommt erst dazu, wenn ein Anker fehlt (Nachschub über imageHq +
 * videoReal, einen Clip voraus).
 */

import { MOOD_BY_KOMBO, type PoolEntry } from './poolManifest';

export interface BankScene {
  id: string;
  label: string;
  /** Same-origin-Clip-URL über den App-Server (kein CORS-Problem). */
  src: string;
  /** Öffentliche R2-URL — nur als Quelle für Server-Route und Nachschub. */
  r2src: string;
  /** Startbild (R2, Referenz für Nachschub/Standbild). */
  startImage: string;
  /** Motiv-Satz, den die Regie für Text/Prompt wiederverwendet. */
  motiv: string;
  /** Kombination (Stil × Motiv) aus dem Vorratslauf. */
  kombo: string;
  /** Echte Clip-Länge in Sekunden (begrenzt die Standdauer). */
  mediaDurationS: number;
}

const R2 = 'https://pub-663ece9f219d4704b826b80715e82034.r2.dev';

function bank(id: string, label: string, kombo: string, motiv: string): BankScene {
  return {
    id,
    label,
    kombo,
    motiv,
    src: `/api/ai/vision/bank/${id}`,
    r2src: `${R2}/visuals/vorlagen/${id}.mp4`,
    startImage: `${R2}/visuals/vorlagen/${id}_start.jpg`,
    mediaDurationS: 3.03,
  };
}

/** Die acht geprüften Vorlagen — Reihenfolge = Show-Reihenfolge. */
export const VISUAL_BANK_SCENES: readonly BankScene[] = [
  bank('neon_stage', 'neon stage', 'psy_techno', 'a lone figure on a neon-lit stage, cinematic light'),
  bank('alien_temple', 'alien temple', 'flux_alien', 'a biomechanical alien temple, dark, immense scale'),
  bank('alien_bluete', 'alien bluete', 'alien_techno', 'a giant alien flower on a black background'),
  bank('maschinen_flur', 'maschinen flur', 'traumraum', 'an endless corridor of machines, fog'),
  bank('geometrie', 'geometrie', 'eskalation', 'floating geometry in an empty void'),
  bank('licht_kathedrale', 'licht kathedrale', 'dark_techno', 'a cathedral of light, impossible architecture'),
  bank('chrom_fluss', 'chrom fluss', 'metal_flow', 'a slow-flowing metal landscape at night'),
  bank('chrom_gesicht', 'chrom gesicht', 'feuer_organik', 'a face dissolving into liquid chrome'),
];

/** Whitelist für die Server-Route: id → öffentliche R2-URL. */
export const BANK_R2_SOURCES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(VISUAL_BANK_SCENES.map((s) => [s.id, s.r2src])),
);

/**
 * Baut aus den acht geprüften Vorlagen-Clips den konkreten Pool des Regisseurs.
 * Stimmung kommt aus der Vorrats-Kombination (`MOOD_BY_KOMBO`), Energie aus der
 * kurzen Clip-Dauer (3,03 s) — beides sind reine Vorlagen, die der User in
 * `poolManifest.ts` umsortieren kann.
 */
export function poolFromBank(): PoolEntry[] {
  return VISUAL_BANK_SCENES.map((b) => ({
    id: b.id,
    src: b.src,
    kind: 'clip' as const,
    source: 'erzeugtes-video' as const,
    mood: MOOD_BY_KOMBO[b.kombo] ?? 'neutral',
    energy: 'mittel' as const,
    tags: [b.kombo],
    durationS: b.mediaDurationS,
    label: b.label,
  }));
}
