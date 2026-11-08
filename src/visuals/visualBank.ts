/**
 * VisualMONK · Vorlagen-Bank (L1-Anker) — Clips im PRIVATEN R2-Bucket
 * ==================================================================
 * Zwei Teile:
 *
 *  1. `VISUAL_BANK_SCENES` — die acht kuratierten Wan-2.2-Vorlagen (Bestand).
 *  2. `IMPORTED_SCENES`   — Clips aus `MONASTRY/Visuals` (20 Themen-Ordner,
 *     erzeugt von `scripts/visual-import/import_monastry.py`). Lizenz und
 *     Attribution je Clip stehen im generierten Modul.
 *
 * Beide liegen in R2 und werden vom App-Server ausgeliefert
 * (`/api/ai/vision/bank/<id>`). Der Bucket ist privat (Lizenzbedingung), es
 * gibt deshalb KEINE oeffentliche `r2.dev`-URL mehr: die Bank fuehrt nur
 * Objekt-Keys, die Route signiert den Zugriff serverseitig per SigV4
 * (`server/routes/aiRoutes.ts`, Muster: `server/routes/mediaProxyRoutes.ts`).
 */

import { MOOD_BY_KOMBO, type PoolEntry } from './poolManifest';
import { IMPORTED_CLIPS } from './importedBank.generated';

export interface BankScene {
  id: string;
  label: string;
  /** Same-origin-Clip-URL über den App-Server (Bucket privat → serverseitig signiert). */
  src: string;
  /** Objekt-Key im privaten Bucket — die Route signiert ihn serverseitig. */
  r2Key: string;
  /** Startbild-Key (Poster/Standbild, same-origin über dieselbe Route). */
  startKey: string;
  /** Motiv-Satz, den die Regie für Text/Prompt wiederverwendet. */
  motiv: string;
  /** Kombination (Stil × Motiv) aus dem Vorratslauf. */
  kombo: string;
  /** Echte Clip-Länge in Sekunden (begrenzt die Standdauer). */
  mediaDurationS: number;
}

/** Länge der importierten Clips (6 s, siehe import_monastry.py). */
const IMPORTED_SECONDS = 6;

function bank(id: string, label: string, kombo: string, motiv: string, duration: number = 3.03): BankScene {
  return {
    id,
    label,
    kombo,
    motiv,
    src: `/api/ai/vision/bank/${id}`,
    r2Key: `visuals/vorlagen/${id}.mp4`,
    startKey: `visuals/vorlagen/${id}_start.jpg`,
    mediaDurationS: duration,
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

/** Importierte Clips aus MONASTRY/Visuals (Themen-Ordner 01–20). */
export const IMPORTED_SCENES: readonly BankScene[] = IMPORTED_CLIPS.map((c) => ({
  id: c.id,
  label: c.label,
  kombo: c.tags[0] ?? 'import',
  motiv: c.title,
  src: `/api/ai/vision/bank/${c.id}`,
  r2Key: `visuals/bank/${c.id}.mp4`,
  startKey: `visuals/bank/${c.id}_start.jpg`,
  mediaDurationS: IMPORTED_SECONDS,
}));

/** Alles, was der Visualizer laden darf: Vorlagen + Importe. */
export const ALL_BANK_SCENES: readonly BankScene[] = [...VISUAL_BANK_SCENES, ...IMPORTED_SCENES];

/**
 * Whitelist für die Server-Route: id → Objekt-Key im PRIVATEN Bucket
 * (inkl. Varianten + Startbilder). Keine URLs, keine Bucket-Namen — die
 * Signatur entsteht erst in der Route aus `resolveR2Config` + `presignUrl`.
 */
export const BANK_R2_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(VISUAL_BANK_SCENES.map((s) => [s.id, s.r2Key] as [string, string])),
  ...Object.fromEntries(IMPORTED_CLIPS.flatMap((c) => [
    [c.id, `visuals/bank/${c.id}.mp4`] as [string, string],
    ...c.varianten.map((v) => [`${c.id}_${v}`, `visuals/bank/${c.id}_${v}.mp4`] as [string, string]),
    // Startbild: Poster/Standbild, ohne das Canvas zu tainten (same-origin).
    [`${c.id}_start`, `visuals/bank/${c.id}_start.jpg`] as [string, string],
  ])),
});

/**
 * Baut aus den acht Vorlagen-Clips den konkreten Pool des Regisseurs.
 * Stimmung kommt aus MOOD_BY_KOMBO, Energie aus den Clips.
 */
export function poolFromBank(): PoolEntry[] {
  return VISUAL_BANK_SCENES.map((b) => ({
    id: b.id,
    src: b.src,
    kind: 'clip' as const,
    source: 'erzeugtes-video' as const,
    mood: MOOD_BY_KOMBO[b.kombo] ?? 'neutral',
    energy: 'mittel' as const,
    tags: [b.kombo, ...b.motiv.toLowerCase().split(/[ ,]+/).filter((t, i) => i < 5)],
    durationS: b.mediaDurationS,
    label: b.label,
  }));
}
