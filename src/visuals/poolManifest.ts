/**
 * VisualMONK · Pool-Manifest (der „Topf”) — reine Clip-Bank ohne LoRA
 * ================================================================
 * Alle Einträge kommen aus der R2-Bank: 8 Clips × 8 Varianten.
 * Keine KI-Generierung, keine LoRAs — nur Playback aus vorhandenen Videos.
 *
 * Jede Variante eines Clips (loop, mirror, quadrat, slow, fast, wide, hue15)
 * ist ein eigenständiger Pool-Eintrag. Das ermöglicht:
 * - Ausgiebige Themen-Auswahl (~60 Einträge durch Kombination)
 * - Determinismus: gleicher Seed → gleiche Wahl
 * - Ästhetisches Rendering: jedes Segment hat Mood, Energy, Tags
 *
 * Quelle: visuals/bank/ auf R2, bank-index.json + varianten-index.json
 * Lizenz: geschützte KI-generierte Inhalte, nur same-origin-Serving
 */

import { IMPORTED_CLIPS } from './importedBank.generated';

/** Woher ein Eintrag stammt — entscheidet Lizenz-/Datenschutz-Behandlung. */
export type PoolSource =
  | 'erzeugtes-video'; // Wan 2.2 Image-to-Video, gehört uns

/** Grobe Stimmung — steuert die Rotation (düster ↔ cool ↔ lustig ↔ neutral). */
export type PoolMood = 'duester' | 'cool' | 'lustig' | 'neutral';

/** Energie-Profil, das die Quelle am besten begleitet. */
export type PoolEnergy = 'ruhig' | 'mittel' | 'hart';

/** Ein Eintrag des Pools. */
export interface PoolEntry {
  /** Stabiler Schlüssel (z. B. `neon_stage-loop` oder `chrom_gesicht-hue15`). */
  id: string;
  /** Same-origin-URL: `/api/ai/vision/bank/{id}.mp4`. */
  src: string;
  /** `clip` = Video (mp4). */
  kind: 'clip';
  source: PoolSource;
  mood: PoolMood;
  energy: PoolEnergy;
  /** Freie Tags: Motiv, Stil, Farben, Aktion. */
  tags: readonly string[];
  /** Dauer in Sekunden (Clip). */
  durationS: number;
  /** Kurzbezeichnung für UI/Log. */
  label?: string;
}

/** Mapping: Kombination → Grobe Stimmung (für visualBank.ts). */
export const MOOD_BY_KOMBO: Readonly<Record<string, PoolMood>> = {
  psy_techno: 'cool',
  flux_alien: 'duester',
  alien_techno: 'duester',
  traumraum: 'duester',
  eskalation: 'cool',
  dark_techno: 'duester',
  metal_flow: 'cool',
  feuer_organik: 'cool',
};

/** Mapping: Clip-ID → Grund-Theme (für Tags/Mood). */
const CLIP_THEME: Readonly<Record<string, { mood: PoolMood; energy: PoolEnergy; tags: string[]; name: string; kombo: string }>> = {
  // NEON / TECHNO (cool, energiegeladen)
  neon_stage: { mood: 'cool', energy: 'hart', tags: ['neon', 'techno', 'stage', 'figure', 'cinematic', 'pulsing', 'haze'], name: 'Neon Stage', kombo: 'psy_techno' },
  // ALIEN / BIOMECH (düster, ausgefallen)
  alien_temple: { mood: 'duester', energy: 'mittel', tags: ['alien', 'biomechanic', 'temple', 'dark', 'scale', 'fog', 'impressive'], name: 'Alien Temple', kombo: 'flux_alien' },
  alien_bluete: { mood: 'duester', energy: 'ruhig', tags: ['alien', 'flower', 'biomechanic', 'organic', 'slow', 'opening'], name: 'Alien Blüte', kombo: 'alien_techno' },
  // MASCHINEN / KORRIDOR (düster, industriell)
  maschinen_flur: { mood: 'duester', energy: 'hart', tags: ['industrial', 'corridor', 'machines', 'fog', 'bones', 'steel', 'vast'], name: 'Maschinen Flur', kombo: 'traumraum' },
  // GEOMETRIE / ABSTRAKT (cool, beweglich)
  geometrie: { mood: 'cool', energy: 'mittel', tags: ['geometry', 'abstract', 'void', 'rotating', 'minimal', 'clean'], name: 'Geometrie', kombo: 'eskalation' },
  // LICHT / KATHEDRAL (cool, majestätisch)
  licht_kathedrale: { mood: 'cool', energy: 'mittel', tags: ['light', 'cathedral', 'beams', 'architecture', 'impossible', 'impressive'], name: 'Licht Kathedrale', kombo: 'dark_techno' },
  // CHROME / FLUSS (cool/neutral, glänzend)
  chrom_fluss: { mood: 'cool', energy: 'mittel', tags: ['chrome', 'liquid', 'dissolving', 'metal', 'smooth', 'flow'], name: 'Chrom Fluss', kombo: 'metal_flow' },
  // CHROME / GESICHT
  chrom_gesicht: { mood: 'cool', energy: 'mittel', tags: ['face', 'chrome', 'liquify', 'abstract'], name: 'Chrom Gesicht', kombo: 'feuer_organik' },
};

/** Basus-Dauern in Sekunden (aus R2-Bank gemessen). */
const BASE_DURATIONS: Record<string, number> = {
  neon_stage: 3.03, alien_temple: 3.03, alien_bluete: 3.03, maschinen_flur: 3.03,
  geometrie: 3.03, licht_kathedrale: 3.03, chrom_fluss: 3.03, chrom_gesicht: 3.03,
};

/**
 * Länge je Variante in Sekunden. Der Renderer erzeugt 6-s-Basisclips; die
 * Varianten ändern die Länge (Ping-Pong verdoppelt, Slow streckt, Fast rafft).
 * Ohne diese Tabelle stünde der Regisseur bei jeder Variante auf 6 s und
 * schnitte Slow mitten in der Bewegung ab.
 *
 * MEDIA-2026-11-04-006: exportiert, weil sie die EINZIGE Dauerquelle ist —
 * Show/Regisseur dürfen keine eigene Dauer-Tabelle mehr führen.
 */
export const DURATION_BY_VARIANT: Readonly<Record<string, number>> = {
  '': 6, loop: 12, slow: 8, fast: 4.07, mirror: 6, quadrat: 6, wide: 6, hue15: 6, grau: 6,
};

/** Dauer einer Variante aus der Tabelle; Unbekanntes fällt auf die Basis (6 s) zurück. */
export function variantDurationS(variant: string): number {
  return DURATION_BY_VARIANT[variant] ?? DURATION_BY_VARIANT[''] ?? 6;
}

/**
 * Die Vorlagen (Wan-Clips) liegen auf R2 **nur als Basisdatei**; ihre Varianten
 * existieren dort nicht (Stichprobe: `neon_stage_loop.mp4` = 404). Deshalb
 * erzeugt der Vorlagen-Pool je Clip genau einen Eintrag — Varianten-Vielfalt
 * kommt aus den importierten Clips (175 × 9).
 */
export const VISUAL_POOL: readonly PoolEntry[] = (() => {
  const entries: PoolEntry[] = [];
  for (const [cid, theme] of Object.entries(CLIP_THEME)) {
    entries.push({
      id: cid,
      src: `/api/ai/vision/bank/${cid}`,
      kind: 'clip',
      source: 'erzeugtes-video',
      mood: theme.mood,
      energy: theme.energy,
      tags: theme.tags,
      durationS: BASE_DURATIONS[cid] ?? 3.03,
      label: theme.name,
    });
  }
  return entries;
})();

/**
 * Pool-Einträge der importierten MONASTRY-Clips: je Clip die Basis plus jede
 * gerenderte Variante (`_loop`, `_quadrat`, `_wide`, `_slow`, `_fast`,
 * `_mirror`, `_hue15`, `_grau`) — jede Variante ist eine eigene R2-Datei und
 * damit ein eigener Pool-Eintrag.
 */
export const IMPORTED_POOL: readonly PoolEntry[] = IMPORTED_CLIPS.flatMap((c) => {
  const mood = c.mood as PoolMood;
  const energy = c.energy as PoolEnergy;
  const base: PoolEntry = {
    id: c.id,
    src: `/api/ai/vision/bank/${c.id}`,
    kind: 'clip',
    source: 'erzeugtes-video',
    mood,
    energy,
    tags: c.tags,
    durationS: variantDurationS(''),
    label: c.label,
  };
  const varianten: PoolEntry[] = c.varianten.map((v) => ({
    id: `${c.id}_${v}`,
    src: `/api/ai/vision/bank/${c.id}_${v}`,
    kind: 'clip',
    source: 'erzeugtes-video',
    mood,
    energy,
    tags: [...c.tags, v],
    // Loop ist doppelt so lang, Slow gestreckt, Fast gerafft (siehe Tabelle).
    durationS: variantDurationS(v),
    label: `${c.label} – ${v}`,
  }));
  return [base, ...varianten];
});

/** Der ganze Topf: Vorlagen-Bank (8 Clips) + Importe (20 Themen). */
export const ALL_POOL: readonly PoolEntry[] = [...VISUAL_POOL, ...IMPORTED_POOL];

/**
 * Nachschlagewerk src → Pool-Eintrag. Der Live-Pfad (`useVisualShow`) bekommt
 * von der UI nur `src`; hier findet er Stimmung, Energie und die Dauer aus
 * `DURATION_BY_VARIANT` dazu, ohne dass die UI den Pool kennen muss.
 */
const POOL_BY_SRC: ReadonlyMap<string, PoolEntry> = new Map(
  ALL_POOL.map((entry) => [entry.src, entry] as const),
);

/** Pool-Eintrag zu einer Quelle — oder null (eigene Bilder/Clips ohne Pool). */
export function poolEntryBySrc(src: string): PoolEntry | null {
  if (!src) return null;
  return POOL_BY_SRC.get(src) ?? null;
}

/** Hilfsfunktion: Einträge nach Mood filtern. */
export function poolByMood(mood: PoolMood): readonly PoolEntry[] {
  return ALL_POOL.filter(e => e.mood === mood);
}

/** Hilfsfunktion: Einträge nach Energy filtern. */
export function poolByEnergy(energy: PoolEnergy): readonly PoolEntry[] {
  return ALL_POOL.filter(e => e.energy === energy);
}

/**
 * Energie aus BPM ableiten — Grundlogik für den Nachschub-Pfad.
 * - Unter 100: ruhig (langsame, atmosphärische Beats)
 * - 100–130: mittel (Standard-Techno-Tempo)
 * - Über 130: hart (schnelle, energiegeladene Rhythmen)
 */
export function energyFromBpm(bpm: number): PoolEnergy {
  if (bpm <= 0) return 'mittel';
  if (bpm < 100) return 'ruhig';
  if (bpm < 130) return 'mittel';
  return 'hart';
}

/**
 * Wähle zufällig ein Element basierend auf Gewichten (deterministisch mit PRNG).
 * @param items - Wahlmöglichkeiten
 * @param weights - Gewichte pro Element (müssen gleich lang sein wie items)
 * @param rng - PRNG-Funktion (z. B. aus mulberry32)
 */
export function pickWeighted<T>(items: T[], weights: number[], rng: () => number): T {
  let total = 0;
  const cumWeights: number[] = [];
  for (const w of weights) {
    total += w;
    cumWeights.push(total);
  }
  const r = rng() * total;
  for (let i = 0; i < cumWeights.length; i++) {
    if (r < cumWeights[i]) return items[i];
  }
  return items[items.length - 1];
}

/** Deterministischer 32-bit PRNG (aus canvasRenderer.ts). */
export function mulberry32(a: number): () => number {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Zufällige Auswahl (deterministisch über Seed).
 *
 * Fisher-Yates statt `sort(() => rng() - 0.5)`: der Comparator-Vergleich ist
 * von der Sortier-Implementierung der Engine abhängig und damit NICHT
 * reproduzierbar — der Determinismus-Zusage („gleicher Seed → gleiche Wahl")
 * widerspricht das.
 */
export function poolSample(n: number, seed: number): readonly PoolEntry[] {
  const rng = mulberry32(seed);
  const pool = [...ALL_POOL];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Die Vorlagen-Einträge des Pools (8 Clips, Basisdatei). Bewusst OHNE
 * `filter(!id.includes('_'))` — die Vorlagen-IDs enthalten selbst
 * Unterstriche (`neon_stage`), ein solcher Filter lieferte nur `geometrie`.
 */
export function poolFromBank(): PoolEntry[] {
  return [...VISUAL_POOL];
}